import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { HttpException, INestApplicationContext } from '@nestjs/common';
import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/prisma/prisma.service';
import { WalletService } from '../../src/modules/wallet/wallet.service';
import { FlashSaleService } from '../../src/modules/flash-sale/flash-sale.service';
import { Prisma } from '../../src/generated/prisma/client';

// Fixed tag so leftover rows from a previous (failed/aborted) run are always
// found and wiped before a fresh run starts - this is what makes repeated
// runs deterministic rather than accumulating stale data.
const TAG = 'concurrency-test';
const PRODUCT_NAME = `${TAG}-product`;
const BUYER_EMAIL = (i: number) => `${TAG}-buyer-${i}@example.local`;
const SENDER_EMAIL = `${TAG}-sender@example.local`;
const RECEIVER_EMAIL = `${TAG}-receiver@example.local`;
const DUMMY_PASSWORD_HASH = 'not-used-by-this-script';

const OVERSELL_STOCK = 10;
const OVERSELL_CONCURRENT_BUYERS = 50;
const PRODUCT_PRICE = 10;
const BUYER_STARTING_BALANCE = 1000;

const DOUBLE_SPEND_CONCURRENT_REQUESTS = 20;
const DOUBLE_SPEND_AMOUNT = 100;
const DOUBLE_SPEND_IDEMPOTENCY_KEY = `${TAG}-double-spend-key`;

let pass = true;
function assertEqual<T>(label: string, actual: T, expected: T) {
  const ok = actual === expected;
  if (!ok) pass = false;
  console.log(
    `  ${ok ? '✅' : '❌'} ${label}: expected=${String(expected)} actual=${String(actual)}`,
  );
}
function assertTrue(label: string, ok: boolean) {
  if (!ok) pass = false;
  console.log(`  ${ok ? '✅' : '❌'} ${label}`);
}

/**
 * Creates a wallet with a starting balance *and* the matching DEPOSIT ledger
 * entry for it. WalletService.verifyInvariant() expects wallet.balance to
 * always equal sum(ledgerEntry.amount) - if we only set `balance` here with
 * no corresponding ledger row (as a bare `prisma.wallet.create` would), the
 * invariant check correctly flags every such wallet as broken even though
 * nothing is actually wrong with the app's transfer/purchase logic. This
 * keeps the seed data itself ledger-consistent.
 */
async function createFundedWallet(
  prisma: PrismaService,
  userId: string,
  startingBalance: number,
) {
  const wallet = await prisma.wallet.create({
    data: { userId, balance: new Prisma.Decimal(startingBalance) },
  });
  if (startingBalance !== 0) {
    await prisma.ledgerEntry.create({
      data: {
        walletId: wallet.id,
        type: 'DEPOSIT',
        amount: new Prisma.Decimal(startingBalance),
        balanceAfter: new Prisma.Decimal(startingBalance),
        referenceId: `${TAG}-seed-${userId}`,
      },
    });
  }
  return wallet;
}

/** Deletes every row this script could have created, from a previous run or this one. */
async function cleanup(prisma: PrismaService) {
  const testUsers = await prisma.user.findMany({
    where: { email: { endsWith: '@example.local' } },
  });
  const userIds = testUsers.map((u) => u.id);
  const wallets = await prisma.wallet.findMany({
    where: { userId: { in: userIds } },
  });
  const walletIds = wallets.map((w) => w.id);

  await prisma.order.deleteMany({ where: { userId: { in: userIds } } });
  const events = await prisma.flashSaleEvent.findMany({
    where: { product: { name: PRODUCT_NAME } },
  });
  await prisma.flashSaleEvent.deleteMany({
    where: { id: { in: events.map((e) => e.id) } },
  });
  await prisma.product.deleteMany({ where: { name: PRODUCT_NAME } });
  await prisma.ledgerEntry.deleteMany({
    where: { walletId: { in: walletIds } },
  });
  await prisma.wallet.deleteMany({ where: { id: { in: walletIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
}

async function runOversellScenario(
  prisma: PrismaService,
  flashSale: FlashSaleService,
) {
  console.log(
    `\n--- Scenario 1: overselling (stock=${OVERSELL_STOCK}, ${OVERSELL_CONCURRENT_BUYERS} concurrent buyers) ---`,
  );

  const product = await prisma.product.create({
    data: { name: PRODUCT_NAME, price: new Prisma.Decimal(PRODUCT_PRICE) },
  });
  const now = Date.now();
  const event = await prisma.flashSaleEvent.create({
    data: {
      productId: product.id,
      totalStock: OVERSELL_STOCK,
      remaining: OVERSELL_STOCK,
      startsAt: new Date(now - 60_000),
      endsAt: new Date(now + 3_600_000),
    },
  });

  const buyerIds: string[] = [];
  for (let i = 0; i < OVERSELL_CONCURRENT_BUYERS; i++) {
    const user = await prisma.user.create({
      data: { email: BUYER_EMAIL(i), password: DUMMY_PASSWORD_HASH },
    });
    await createFundedWallet(prisma, user.id, BUYER_STARTING_BALANCE);
    buyerIds.push(user.id);
  }

  const results = await Promise.allSettled(
    buyerIds.map((userId, i) =>
      flashSale.purchase(userId, {
        eventId: event.id,
        idempotencyKey: `${TAG}-oversell-${i}`,
      }),
    ),
  );

  const succeeded = results.filter(
    (r) => r.status === 'fulfilled' && r.value.status === 'CONFIRMED',
  );
  const failed = results.filter((r) => r.status === 'rejected');
  const unexpected = results.filter(
    (r) => r.status === 'fulfilled' && r.value.status !== 'CONFIRMED',
  );

  // Every failure must be a clean, known 4xx (ConflictException => 409), never
  // an unhandled/500-shaped error or a timeout.
  const failuresAreClean = failed.every(
    (r) => r.reason instanceof HttpException && r.reason.getStatus() === 409,
  );

  console.log(
    `  succeeded=${succeeded.length} failed=${failed.length} unexpected=${unexpected.length}`,
  );
  assertEqual('exactly 10 purchases succeeded', succeeded.length, 10);
  assertEqual(
    'exactly 40 purchases failed',
    failed.length,
    OVERSELL_CONCURRENT_BUYERS - 10,
  );
  assertTrue(
    'every failure was a clean 409 (stock exhausted), not a 500/timeout',
    failuresAreClean,
  );

  const finalEvent = await prisma.flashSaleEvent.findUniqueOrThrow({
    where: { id: event.id },
  });
  assertEqual('FlashSaleEvent.remaining is exactly 0', finalEvent.remaining, 0);

  const confirmedOrders = await prisma.order.count({
    where: { flashSaleEventId: event.id, status: 'CONFIRMED' },
  });
  assertEqual('exactly 10 CONFIRMED Order rows', confirmedOrders, 10);

  return { touchedUserIds: buyerIds };
}

async function runDoubleSpendScenario(
  prisma: PrismaService,
  wallet: WalletService,
) {
  console.log(
    `\n--- Scenario 2: double-spend (${DOUBLE_SPEND_CONCURRENT_REQUESTS} concurrent transfers, same idempotencyKey) ---`,
  );

  const sender = await prisma.user.create({
    data: { email: SENDER_EMAIL, password: DUMMY_PASSWORD_HASH },
  });
  const receiver = await prisma.user.create({
    data: { email: RECEIVER_EMAIL, password: DUMMY_PASSWORD_HASH },
  });
  const senderWallet = await createFundedWallet(
    prisma,
    sender.id,
    DOUBLE_SPEND_AMOUNT,
  );
  await createFundedWallet(prisma, receiver.id, 0);

  const results = await Promise.allSettled(
    Array.from({ length: DOUBLE_SPEND_CONCURRENT_REQUESTS }, () =>
      wallet.transfer(sender.id, {
        toUserId: receiver.id,
        amount: DOUBLE_SPEND_AMOUNT,
        idempotencyKey: DOUBLE_SPEND_IDEMPOTENCY_KEY,
      }),
    ),
  );
  const succeeded = results.filter((r) => r.status === 'fulfilled').length;
  const failed = results.length - succeeded;
  console.log(`  succeeded=${succeeded} failed=${failed}`);

  const finalSenderWallet = await prisma.wallet.findUniqueOrThrow({
    where: { id: senderWallet.id },
  });
  assertEqual(
    'sender balance is exactly 0 (deducted once, not negative)',
    finalSenderWallet.balance.toNumber(),
    0,
  );

  const transferOutCount = await prisma.ledgerEntry.count({
    where: {
      walletId: senderWallet.id,
      type: 'TRANSFER_OUT',
      referenceId: DOUBLE_SPEND_IDEMPOTENCY_KEY,
    },
  });
  assertEqual(
    'exactly 1 TRANSFER_OUT ledger entry for that referenceId',
    transferOutCount,
    1,
  );

  return { touchedUserIds: [sender.id, receiver.id] };
}

async function runLedgerInvariantScenario(
  prisma: PrismaService,
  wallet: WalletService,
  touchedUserIds: string[],
) {
  console.log(
    `\n--- Scenario 3: ledger invariant (sum(ledger) == wallet.balance) for ${touchedUserIds.length} touched wallets ---`,
  );

  const wallets = await prisma.wallet.findMany({
    where: { userId: { in: touchedUserIds } },
  });
  const checks = await Promise.all(
    wallets.map((w) => wallet.verifyInvariant(w.id)),
  );
  const flat = checks.flat();
  const allMatch = flat.every((c) => c.matches);
  const broken = flat.filter((c) => !c.matches);
  if (broken.length > 0) {
    console.log('  broken wallets:', broken);
  }
  assertTrue(
    `ledger invariant holds for all ${flat.length} touched wallets`,
    allMatch,
  );
}

async function main() {
  let app: INestApplicationContext | undefined;
  try {
    console.log('Booting application context (Postgres/Redis/BullMQ)...');
    app = await NestFactory.createApplicationContext(AppModule, {
      logger: ['error', 'warn', 'log'],
      // Nest's default (abortOnError: true) calls process.exit(1) itself the
      // moment bootstrap fails, after logging through its *own* internal
      // logger - which we had disabled (logger: false), so the process died
      // silently before this try/catch or the unhandledRejection handler
      // below ever got a chance to run. abortOnError: false makes bootstrap
      // failures throw a normal exception instead, so we can catch and print
      // them ourselves.
      abortOnError: false,
    });
    console.log('Application context ready.');
    const prisma = app.get(PrismaService);
    const walletService = app.get(WalletService);
    const flashSaleService = app.get(FlashSaleService);

    console.log('Cleaning up any leftover data from a previous run...');
    await cleanup(prisma);

    const { touchedUserIds: oversellUserIds } = await runOversellScenario(
      prisma,
      flashSaleService,
    );
    const { touchedUserIds: doubleSpendUserIds } = await runDoubleSpendScenario(
      prisma,
      walletService,
    );
    await runLedgerInvariantScenario(prisma, walletService, [
      ...oversellUserIds,
      ...doubleSpendUserIds,
    ]);

    console.log('\nCleaning up test data...');
    await cleanup(prisma);

    console.log(`\n=== RESULT: ${pass ? 'PASS ✅' : 'FAIL ❌'} ===`);
    process.exitCode = pass ? 0 : 1;
  } catch (err) {
    console.error('\nConcurrency script crashed:', err);
    process.exitCode = 1;
  } finally {
    if (app) {
      // Best-effort cleanup even if a scenario threw before its own cleanup ran.
      try {
        await cleanup(app.get(PrismaService));
      } catch {
        /* already cleaned or app never fully started - ignore */
      }
      await app.close();
    }
  }
}

process.on('unhandledRejection', (err) => {
  console.error('\nUNHANDLED REJECTION (this should not happen):', err);
  process.exitCode = 1;
});

main().catch((err) => {
  console.error('\nFATAL - main() rejected:', err);
  process.exitCode = 1;
});
