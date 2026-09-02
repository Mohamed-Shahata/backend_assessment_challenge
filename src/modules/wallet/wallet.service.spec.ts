import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { WalletService } from './wallet.service';

type WalletFixture = {
  id: string;
  userId: string;
  balance: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
};

describe('WalletService', () => {
  let service: WalletService;
  let prisma: {
    $transaction: jest.Mock;
    wallet: {
      findUnique: jest.Mock;
      findMany: jest.Mock;
      findUniqueOrThrow: jest.Mock;
    };
    ledgerEntry: {
      aggregate: jest.Mock;
    };
  };
  let tx: {
    wallet: { findUnique: jest.Mock; update: jest.Mock };
    ledgerEntry: { create: jest.Mock; findUnique: jest.Mock };
    $queryRaw: jest.Mock;
  };
  let redis: { get: jest.Mock; set: jest.Mock };

  const wallet = (over: Partial<WalletFixture> = {}): WalletFixture => ({
    id: 'wallet-1',
    userId: 'user-1',
    balance: '100.00',
    version: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  });

  beforeEach(() => {
    tx = {
      wallet: {
        findUnique: jest.fn(),
        update: jest.fn(async ({ where, data }) => ({
          id: where.id,
          balance: data.balance,
        })),
      },
      ledgerEntry: {
        create: jest.fn(async ({ data }) => ({ id: 'entry-1', ...data })),
        findUnique: jest.fn().mockResolvedValue(null),
      },
      $queryRaw: jest.fn(),
    };

    prisma = {
      $transaction: jest.fn((cb: (tx: unknown) => unknown) => cb(tx)),
      wallet: {
        findUnique: jest.fn(),
        findMany: jest.fn(),
        findUniqueOrThrow: jest.fn(),
      },
      ledgerEntry: {
        aggregate: jest.fn(),
      },
    };

    redis = { get: jest.fn().mockResolvedValue(null), set: jest.fn() };

    service = new WalletService(prisma as never, redis as never);
  });

  describe('deposit', () => {
    it('increases the balance and records a DEPOSIT ledger entry', async () => {
      const w = wallet({ balance: '100.00' });
      tx.wallet.findUnique.mockResolvedValue(w);
      tx.$queryRaw.mockResolvedValue([w]);

      const result = await service.deposit('user-1', { amount: 25.5 });

      expect(result.balance.toString()).toBe('125.5');
      expect(tx.ledgerEntry.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            walletId: 'wallet-1',
            type: 'DEPOSIT',
          }),
        }),
      );
      const created = tx.ledgerEntry.create.mock.calls[0][0].data;
      expect((created.amount as Prisma.Decimal).toString()).toBe('25.5');
    });

    it('throws NotFoundException when the wallet does not exist', async () => {
      tx.wallet.findUnique.mockResolvedValue(null);

      await expect(
        service.deposit('ghost-user', { amount: 10 }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('transfer', () => {
    const sender = wallet({
      id: 'wallet-a',
      userId: 'user-a',
      balance: '50.00',
    });
    const receiver = wallet({
      id: 'wallet-b',
      userId: 'user-b',
      balance: '10.00',
    });

    beforeEach(() => {
      prisma.wallet.findUnique.mockImplementation(async () => undefined); // unused (tx is used, not prisma, inside $transaction)
      tx.wallet.findUnique.mockImplementation(async ({ where }) => {
        if (where.userId === 'user-a') return sender;
        if (where.userId === 'user-b') return receiver;
        return null;
      });
      tx.$queryRaw.mockImplementation(
        async (_strings: unknown, walletId: string) => {
          if (walletId === 'wallet-a') return [sender];
          if (walletId === 'wallet-b') return [receiver];
          return [];
        },
      );
    });

    it('rejects a transfer that exceeds the sender balance (checked after the lock)', async () => {
      await expect(
        service.transfer('user-a', {
          toUserId: 'user-b',
          amount: 999,
          idempotencyKey: 'k-1',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('moves funds and writes matching TRANSFER_OUT / TRANSFER_IN entries with the same referenceId', async () => {
      const result = await service.transfer('user-a', {
        toUserId: 'user-b',
        amount: 20,
        idempotencyKey: 'k-2',
      });

      expect(result).toMatchObject({
        fromBalance: '30',
        toBalance: '30',
        referenceId: 'k-2',
      });

      const [outCall, inCall] = tx.ledgerEntry.create.mock.calls;
      expect(outCall[0].data.type).toBe('TRANSFER_OUT');
      expect(outCall[0].data.referenceId).toBe('k-2');
      expect((outCall[0].data.amount as Prisma.Decimal).toString()).toBe('-20');
      expect(inCall[0].data.type).toBe('TRANSFER_IN');
      expect(inCall[0].data.referenceId).toBe('k-2');
      expect((inCall[0].data.amount as Prisma.Decimal).toString()).toBe('20');
    });

    it('rejects transferring to yourself before touching the database', async () => {
      await expect(
        service.transfer('user-a', {
          toUserId: 'user-a',
          amount: 10,
          idempotencyKey: 'k-3',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('replays a cached result from Redis instead of transacting again', async () => {
      redis.get.mockResolvedValue(
        JSON.stringify({ referenceId: 'k-4', cached: true }),
      );

      const result = await service.transfer('user-a', {
        toUserId: 'user-b',
        amount: 5,
        idempotencyKey: 'k-4',
      });

      expect(result).toEqual({ referenceId: 'k-4', cached: true });
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });
  });

  describe('verifyInvariant', () => {
    it('flags a wallet whose balance does not match the sum of its ledger entries', async () => {
      prisma.wallet.findMany.mockResolvedValue([wallet({ balance: '100.00' })]);
      prisma.ledgerEntry.aggregate.mockResolvedValue({
        _sum: { amount: new Prisma.Decimal('90.00') },
      });

      const [check] = await service.verifyInvariant();

      expect(check.matches).toBe(false);
      expect(check.balance).toBe('100');
      expect(check.ledgerSum).toBe('90');
    });

    it('passes when the ledger sum matches the wallet balance', async () => {
      prisma.wallet.findMany.mockResolvedValue([wallet({ balance: '125.50' })]);
      prisma.ledgerEntry.aggregate.mockResolvedValue({
        _sum: { amount: new Prisma.Decimal('125.50') },
      });

      const [check] = await service.verifyInvariant();

      expect(check.matches).toBe(true);
    });
  });
});
