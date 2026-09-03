import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { Queue } from 'bullmq';
import { OrderStatus, Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { WalletService } from '../wallet/wallet.service';
import { CreateFlashSaleEventDto } from './dto/create-flash-sale-event.dto';
import { PurchaseFlashSaleDto } from './dto/purchase-flash-sale.dto';
import { FLASH_SALE_QUEUE } from './queue/flash-sale-queue.constants';

/** Row shape returned by the atomic `UPDATE ... RETURNING remaining` reservation query. */
interface ReservationRow {
  remaining: number;
}

const isUniqueConstraintViolation = (
  err: unknown,
): err is Prisma.PrismaClientKnownRequestError =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';

@Injectable()
export class FlashSaleService {
  private readonly logger = new Logger(FlashSaleService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly walletService: WalletService,
    @Inject(FLASH_SALE_QUEUE) private readonly queue: Queue,
  ) {}

  async createEvent(dto: CreateFlashSaleEventDto) {
    const product = await this.prisma.product.findUnique({
      where: { id: dto.productId },
    });
    if (!product) {
      throw new NotFoundException('Product not found');
    }

    return this.prisma.flashSaleEvent.create({
      data: {
        productId: dto.productId,
        totalStock: dto.totalStock,
        remaining: dto.totalStock,
        startsAt: new Date(dto.startsAt),
        endsAt: new Date(dto.endsAt),
      },
    });
  }

  async getEvent(id: string) {
    const event = await this.prisma.flashSaleEvent.findUnique({
      where: { id },
      include: { product: true },
    });
    if (!event) {
      throw new NotFoundException('Flash-sale event not found');
    }
    return event;
  }

  /**
   * Purchase flow. Two sequential steps (stock reservation, then wallet
   * deduction) with a compensating action on failure, rather than a single
   * cross-domain DB transaction — see the task README's "Implementation
   * Notes" for the reasoning.
   */
  async purchase(userId: string, dto: PurchaseFlashSaleDto) {
    const existing = await this.findExistingOrder(
      dto.eventId,
      dto.idempotencyKey,
    );
    if (existing) {
      return this.toOrderResult(existing, true);
    }

    const event = await this.prisma.flashSaleEvent.findUnique({
      where: { id: dto.eventId },
      include: { product: true },
    });
    if (!event) {
      throw new NotFoundException('Flash-sale event not found');
    }

    const now = new Date();
    if (now < event.startsAt || now > event.endsAt) {
      throw new BadRequestException('Flash-sale event is not currently active');
    }

    // Atomic at the DB level: only succeeds while remaining > 0, so
    // concurrent requests can never oversell the same unit.
    const reserved = await this.reserveUnit(dto.eventId);
    if (!reserved) {
      throw new ConflictException(
        'Stock is exhausted for this flash-sale event',
      );
    }

    const orderId = randomUUID();
    // Deterministic (not random) so that two concurrent requests carrying the
    // *same* idempotencyKey deduct the wallet at most once, even if both slip
    // past the findExistingOrder check above before either has written an Order row.
    const walletReferenceId = `flash-sale:${dto.eventId}:${dto.idempotencyKey}`;

    try {
      await this.walletService.purchaseDeduct(
        userId,
        event.product.price,
        walletReferenceId,
      );
    } catch (err) {
      // Wallet deduction failed (e.g. insufficient balance): give the unit back.
      await this.releaseUnit(dto.eventId);

      const order = await this.finalizeOrder({
        id: orderId,
        userId,
        flashSaleEventId: dto.eventId,
        idempotencyKey: dto.idempotencyKey,
        status: OrderStatus.FAILED,
        onConflict: () => this.releaseUnit(dto.eventId),
      });
      if (order.raced) {
        return this.toOrderResult(order.order, true);
      }
      throw err;
    }

    const order = await this.finalizeOrder({
      id: orderId,
      userId,
      flashSaleEventId: dto.eventId,
      idempotencyKey: dto.idempotencyKey,
      status: OrderStatus.CONFIRMED,
      // We already paid via the idempotent walletReferenceId above, so on a
      // losing race here we don't reverse the payment - the pre-existing
      // (winning) order below is simply returned to the caller.
      onConflict: () => this.releaseUnit(dto.eventId),
    });

    if (!order.raced && order.order.status === OrderStatus.CONFIRMED) {
      await this.queue
        .add('order-confirmed', {
          orderId: order.order.id,
          userId,
          eventId: dto.eventId,
          productId: event.productId,
        })
        .catch((err: Error) =>
          this.logger.error(
            `Failed to enqueue order-confirmed job: ${err.message}`,
          ),
        );
    }

    return this.toOrderResult(order.order, order.raced);
  }

  private findExistingOrder(flashSaleEventId: string, idempotencyKey: string) {
    return this.prisma.order.findUnique({
      where: {
        flashSaleEventId_idempotencyKey: { flashSaleEventId, idempotencyKey },
      },
    });
  }

  /** Atomically decrements `remaining` if > 0. Returns true iff a unit was reserved. */
  private async reserveUnit(eventId: string): Promise<boolean> {
    const rows = await this.prisma.$queryRaw<ReservationRow[]>`
      UPDATE "FlashSaleEvent"
      SET "remaining" = "remaining" - 1
      WHERE "id" = ${eventId} AND "remaining" > 0
      RETURNING "remaining"
    `;
    return rows.length > 0;
  }

  /** Compensating action: returns a previously-reserved unit back to stock. */
  private async releaseUnit(eventId: string): Promise<void> {
    await this.prisma.$queryRaw`
      UPDATE "FlashSaleEvent"
      SET "remaining" = "remaining" + 1
      WHERE "id" = ${eventId}
    `;
  }

  /**
   * Creates the Order row. If a concurrent request already created one for
   * the same (eventId, idempotencyKey) - the unique constraint fires - we
   * run `onConflict` (release the unit *this* request reserved) and return
   * the row the other request wrote instead.
   */
  private async finalizeOrder(params: {
    id: string;
    userId: string;
    flashSaleEventId: string;
    idempotencyKey: string;
    status: OrderStatus;
    onConflict: () => Promise<void>;
  }) {
    try {
      const order = await this.prisma.order.create({
        data: {
          id: params.id,
          userId: params.userId,
          flashSaleEventId: params.flashSaleEventId,
          idempotencyKey: params.idempotencyKey,
          status: params.status,
        },
      });
      return { order, raced: false as const };
    } catch (err) {
      if (!isUniqueConstraintViolation(err)) {
        throw err;
      }
      this.logger.warn(
        `Concurrent duplicate purchase request for event=${params.flashSaleEventId} idempotencyKey=${params.idempotencyKey}`,
      );
      await params.onConflict();
      const existing = await this.findExistingOrder(
        params.flashSaleEventId,
        params.idempotencyKey,
      );
      if (!existing) {
        // Should not happen: the constraint violation implies a row exists.
        throw err;
      }
      return { order: existing, raced: true as const };
    }
  }

  private toOrderResult(
    order: {
      id: string;
      userId: string;
      flashSaleEventId: string;
      status: OrderStatus;
      idempotencyKey: string;
      createdAt: Date;
    },
    replayed: boolean,
  ) {
    return {
      orderId: order.id,
      eventId: order.flashSaleEventId,
      status: order.status,
      idempotencyKey: order.idempotencyKey,
      createdAt: order.createdAt,
      replayed,
    };
  }
}
