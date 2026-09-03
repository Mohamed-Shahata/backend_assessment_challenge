import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { Redis } from 'ioredis';
import { LedgerType, Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { REDIS_CLIENT } from '../../redis/redis.constants';
import { DepositDto } from './dto/deposit.dto';
import { TransferDto } from './dto/transfer.dto';
import {
  LockedWallet,
  WalletRow,
  toLockedWallet,
} from '../../auth/utils/wallet-row';

type PrismaTx = Prisma.TransactionClient;

const IDEMPOTENCY_TTL_SECONDS = 60 * 60 * 24; // 24h, second-line defense lives in Redis
const DEFAULT_LEDGER_LIMIT = 20;
const IDEMPOTENCY_KEY_PREFIX = 'wallet:transfer';

@Injectable()
export class WalletService {
  private readonly logger = new Logger(WalletService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  /** Called from AuthService.register inside the same Prisma transaction. */
  async provisionWallet(userId: string, tx?: PrismaTx): Promise<void> {
    const client = tx ?? this.prisma;
    await client.wallet.create({
      data: { userId, balance: new Prisma.Decimal(0) },
    });
  }

  async getMe(userId: string, limit = DEFAULT_LEDGER_LIMIT) {
    const wallet = await this.prisma.wallet.findUnique({ where: { userId } });
    if (!wallet) {
      throw new NotFoundException('Wallet not found for this user');
    }

    const entries = await this.prisma.ledgerEntry.findMany({
      where: { walletId: wallet.id },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });

    return { balance: wallet.balance, entries };
  }

  async deposit(userId: string, dto: DepositDto) {
    const amount = new Prisma.Decimal(dto.amount);
    const referenceId = randomUUID();

    return this.prisma.$transaction(async (tx) => {
      const wallet = await this.lockWalletByUserId(tx, userId);
      const newBalance = wallet.balance.plus(amount);

      const updated = await tx.wallet.update({
        where: { id: wallet.id },
        data: { balance: newBalance, version: { increment: 1 } },
      });

      const entry = await tx.ledgerEntry.create({
        data: {
          walletId: wallet.id,
          type: LedgerType.DEPOSIT,
          amount,
          balanceAfter: newBalance,
          referenceId,
        },
      });

      return { walletId: wallet.id, balance: updated.balance, entry };
    });
  }

  /**
   * Deducts `amount` from the user's wallet for a purchase (flash-sale, etc.)
   * and records a PURCHASE ledger entry. Idempotent on `referenceId`
   * (typically the Order id) via the `@@unique([walletId, referenceId, type])`
   * constraint on LedgerEntry — a retry with the same referenceId returns the
   * original ledger entry instead of deducting twice.
   * Throws BadRequestException if the balance is insufficient.
   */
  async purchaseDeduct(
    userId: string,
    amount: Prisma.Decimal,
    referenceId: string,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const wallet = await this.lockWalletByUserId(tx, userId);

      const existing = await tx.ledgerEntry.findUnique({
        where: {
          walletId_referenceId_type: {
            walletId: wallet.id,
            referenceId,
            type: LedgerType.PURCHASE,
          },
        },
      });
      if (existing) {
        return {
          walletId: wallet.id,
          balance: existing.balanceAfter,
          entry: existing,
        };
      }

      if (wallet.balance.lt(amount)) {
        throw new BadRequestException('Insufficient balance');
      }

      const newBalance = wallet.balance.minus(amount);

      const updated = await tx.wallet.update({
        where: { id: wallet.id },
        data: { balance: newBalance, version: { increment: 1 } },
      });

      const entry = await tx.ledgerEntry.create({
        data: {
          walletId: wallet.id,
          type: LedgerType.PURCHASE,
          amount: amount.negated(),
          balanceAfter: newBalance,
          referenceId,
        },
      });

      return { walletId: wallet.id, balance: updated.balance, entry };
    });
  }

  async transfer(userId: string, dto: TransferDto) {
    if (dto.toUserId === userId) {
      throw new BadRequestException('Cannot transfer to yourself');
    }

    const amount = new Prisma.Decimal(dto.amount);
    const idemKey = `${IDEMPOTENCY_KEY_PREFIX}:${userId}:${dto.idempotencyKey}`;

    // First line of defense: fast Redis lookup for a request we already handled.
    const cached = await this.redis.get(idemKey);
    if (cached) {
      return JSON.parse(cached) as Record<string, unknown>;
    }

    const result = await this.prisma.$transaction(async (tx) => {
      const [senderRef, receiverRef] = await Promise.all([
        tx.wallet.findUnique({ where: { userId } }),
        tx.wallet.findUnique({ where: { userId: dto.toUserId } }),
      ]);
      if (!senderRef) throw new NotFoundException('Sender wallet not found');
      if (!receiverRef)
        throw new NotFoundException('Recipient wallet not found');

      // Second line of defense: the same idempotencyKey already produced a
      // TRANSFER_OUT entry for this wallet -> return the old result as-is.
      const existingOut = await tx.ledgerEntry.findUnique({
        where: {
          walletId_referenceId_type: {
            walletId: senderRef.id,
            referenceId: dto.idempotencyKey,
            type: 'TRANSFER_OUT',
          },
        },
      });
      if (existingOut) {
        return {
          fromWalletId: senderRef.id,
          toWalletId: receiverRef.id,
          amount: existingOut.amount.negated().toString(),
          fromBalance: existingOut.balanceAfter.toString(),
          referenceId: dto.idempotencyKey,
          replayed: true,
        };
      }

      // Fixed lock order (smallest wallet id first) so two opposite
      // transfers (A->B and B->A) can never deadlock on each other.
      const [firstId, secondId] = [senderRef.id, receiverRef.id].sort();
      const first = await this.lockWalletById(tx, firstId);
      const second = await this.lockWalletById(tx, secondId);
      const sender = first.id === senderRef.id ? first : second;
      const receiver = first.id === receiverRef.id ? first : second;

      // Balance check happens after the lock is held, on the locked snapshot.
      if (sender.balance.lt(amount)) {
        throw new BadRequestException('Insufficient balance');
      }

      const newSenderBalance = sender.balance.minus(amount);
      const newReceiverBalance = receiver.balance.plus(amount);

      await tx.wallet.update({
        where: { id: sender.id },
        data: { balance: newSenderBalance, version: { increment: 1 } },
      });
      await tx.wallet.update({
        where: { id: receiver.id },
        data: { balance: newReceiverBalance, version: { increment: 1 } },
      });

      await Promise.all([
        tx.ledgerEntry.create({
          data: {
            walletId: sender.id,
            type: 'TRANSFER_OUT',
            amount: amount.negated(),
            balanceAfter: newSenderBalance,
            referenceId: dto.idempotencyKey,
          },
        }),
        tx.ledgerEntry.create({
          data: {
            walletId: receiver.id,
            type: 'TRANSFER_IN',
            amount,
            balanceAfter: newReceiverBalance,
            referenceId: dto.idempotencyKey,
          },
        }),
      ]);

      return {
        fromWalletId: sender.id,
        toWalletId: receiver.id,
        amount: amount.toString(),
        fromBalance: newSenderBalance.toString(),
        toBalance: newReceiverBalance.toString(),
        referenceId: dto.idempotencyKey,
        replayed: false,
      };
    });

    await this.redis.set(
      idemKey,
      JSON.stringify(result),
      'EX',
      IDEMPOTENCY_TTL_SECONDS,
    );
    return result;
  }

  /** sum(LedgerEntry.amount) must equal Wallet.balance for every wallet. */
  async verifyInvariant(walletId?: string) {
    const wallets = walletId
      ? [
          await this.prisma.wallet.findUniqueOrThrow({
            where: { id: walletId },
          }),
        ]
      : await this.prisma.wallet.findMany();

    return Promise.all(
      wallets.map(async (wallet) => {
        const agg = await this.prisma.ledgerEntry.aggregate({
          where: { walletId: wallet.id },
          _sum: { amount: true },
        });
        const ledgerSum = new Prisma.Decimal(agg._sum.amount ?? 0);
        const balance = new Prisma.Decimal(wallet.balance);
        const matches = balance.equals(ledgerSum);
        if (!matches) {
          this.logger.warn(
            `Ledger invariant broken for wallet ${wallet.id}: balance=${balance.toString()} sum(ledger)=${ledgerSum.toString()}`,
          );
        }
        return {
          walletId: wallet.id,
          balance: balance.toString(),
          ledgerSum: ledgerSum.toString(),
          matches,
        };
      }),
    );
  }

  private async lockWalletByUserId(
    tx: PrismaTx,
    userId: string,
  ): Promise<LockedWallet> {
    const wallet = await tx.wallet.findUnique({ where: { userId } });
    if (!wallet) {
      throw new NotFoundException('Wallet not found for this user');
    }
    return this.lockWalletById(tx, wallet.id);
  }

  private async lockWalletById(
    tx: PrismaTx,
    walletId: string,
  ): Promise<LockedWallet> {
    const rows = await tx.$queryRaw<
      WalletRow[]
    >`SELECT * FROM "Wallet" WHERE id = ${walletId} FOR UPDATE`;
    if (!rows[0]) {
      throw new NotFoundException('Wallet not found');
    }
    return toLockedWallet(rows[0]);
  }
}
