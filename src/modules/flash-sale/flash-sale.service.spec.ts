import { BadRequestException, ConflictException } from '@nestjs/common';
import { OrderStatus, Prisma } from '../../generated/prisma/client';
import { FlashSaleService } from './flash-sale.service';

describe('FlashSaleService', () => {
  let service: FlashSaleService;
  let prisma: {
    product: { findUnique: jest.Mock };
    flashSaleEvent: { create: jest.Mock; findUnique: jest.Mock };
    order: { findUnique: jest.Mock; create: jest.Mock };
    $queryRaw: jest.Mock;
  };
  let walletService: { purchaseDeduct: jest.Mock };
  let queue: { add: jest.Mock };

  const event = (over: Partial<Record<string, unknown>> = {}) => ({
    id: 'event-1',
    productId: 'product-1',
    totalStock: 10,
    remaining: 10,
    startsAt: new Date(Date.now() - 60_000),
    endsAt: new Date(Date.now() + 60_000),
    product: { id: 'product-1', name: 'Widget', price: new Prisma.Decimal(50) },
    ...over,
  });

  beforeEach(() => {
    prisma = {
      product: { findUnique: jest.fn() },
      flashSaleEvent: { create: jest.fn(), findUnique: jest.fn() },
      order: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      $queryRaw: jest.fn(),
    };
    walletService = { purchaseDeduct: jest.fn() };
    queue = { add: jest.fn().mockResolvedValue(undefined) };

    service = new FlashSaleService(
      prisma as never,
      walletService as never,
      queue as never,
    );
  });

  describe('purchase - time window', () => {
    it('rejects a purchase before the event starts', async () => {
      prisma.flashSaleEvent.findUnique.mockResolvedValue(
        event({ startsAt: new Date(Date.now() + 60_000) }),
      );

      await expect(
        service.purchase('user-1', {
          eventId: 'event-1',
          idempotencyKey: 'k1',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
    });

    it('rejects a purchase after the event ends', async () => {
      prisma.flashSaleEvent.findUnique.mockResolvedValue(
        event({ endsAt: new Date(Date.now() - 60_000) }),
      );

      await expect(
        service.purchase('user-1', {
          eventId: 'event-1',
          idempotencyKey: 'k1',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('purchase - stock', () => {
    it('returns a clean 409 (not a 500) when stock is exhausted', async () => {
      prisma.flashSaleEvent.findUnique.mockResolvedValue(event());
      prisma.$queryRaw.mockResolvedValue([]); // reservation UPDATE returned no row

      await expect(
        service.purchase('user-1', {
          eventId: 'event-1',
          idempotencyKey: 'k1',
        }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(walletService.purchaseDeduct).not.toHaveBeenCalled();
    });

    it('reserves a unit and confirms the order on success', async () => {
      prisma.flashSaleEvent.findUnique.mockResolvedValue(event());
      prisma.$queryRaw.mockResolvedValue([{ remaining: 9 }]); // reservation succeeded
      walletService.purchaseDeduct.mockResolvedValue({ balance: '50.00' });
      prisma.order.create.mockImplementation(
        ({ data }: { data: Record<string, unknown> }) =>
          Promise.resolve({
            ...data,
            createdAt: new Date(),
          }),
      );

      const result = await service.purchase('user-1', {
        eventId: 'event-1',
        idempotencyKey: 'k1',
      });

      expect(result.status).toBe(OrderStatus.CONFIRMED);
      expect(result.replayed).toBe(false);
      expect(walletService.purchaseDeduct).toHaveBeenCalledWith(
        'user-1',
        event().product.price,
        'flash-sale:event-1:k1',
      );
      expect(queue.add).toHaveBeenCalledWith(
        'order-confirmed',
        expect.objectContaining({ userId: 'user-1', eventId: 'event-1' }),
      );
    });
  });

  describe('purchase - idempotency', () => {
    it('returns the existing order without reserving stock again', async () => {
      const existing = {
        id: 'order-1',
        userId: 'user-1',
        flashSaleEventId: 'event-1',
        status: OrderStatus.CONFIRMED,
        idempotencyKey: 'k1',
        createdAt: new Date(),
      };
      prisma.order.findUnique.mockResolvedValue(existing);

      const result = await service.purchase('user-1', {
        eventId: 'event-1',
        idempotencyKey: 'k1',
      });

      expect(result.orderId).toBe('order-1');
      expect(result.replayed).toBe(true);
      expect(prisma.flashSaleEvent.findUnique).not.toHaveBeenCalled();
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
    });
  });

  describe('purchase - compensating rollback', () => {
    it('releases the reserved unit and records a FAILED order when the wallet deduction fails', async () => {
      prisma.flashSaleEvent.findUnique.mockResolvedValue(event());
      prisma.$queryRaw.mockResolvedValue([{ remaining: 9 }]); // reservation succeeded
      const walletError = new BadRequestException('Insufficient balance');
      walletService.purchaseDeduct.mockRejectedValue(walletError);
      prisma.order.create.mockImplementation(
        ({ data }: { data: Record<string, unknown> }) =>
          Promise.resolve({
            ...data,
            createdAt: new Date(),
          }),
      );

      await expect(
        service.purchase('user-1', {
          eventId: 'event-1',
          idempotencyKey: 'k1',
        }),
      ).rejects.toBe(walletError);

      // 1st $queryRaw call = reservation, 2nd = compensating release.
      expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
      expect(prisma.order.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: OrderStatus.FAILED }),
        }),
      );
      expect(queue.add).not.toHaveBeenCalled();
    });
  });
});
