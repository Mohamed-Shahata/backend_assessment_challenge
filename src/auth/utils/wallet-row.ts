import { Prisma } from '../../generated/prisma/client';

/** Shape returned by the raw `SELECT ... FOR UPDATE` locking queries. */
export interface WalletRow {
  id: string;
  userId: string;
  balance: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

/** A wallet row with `balance` parsed into a Prisma.Decimal for safe arithmetic. */
export interface LockedWallet extends Omit<WalletRow, 'balance'> {
  balance: Prisma.Decimal;
}

export function toLockedWallet(row: WalletRow): LockedWallet {
  return { ...row, balance: new Prisma.Decimal(row.balance) };
}
