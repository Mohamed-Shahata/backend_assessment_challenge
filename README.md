# Digital Wallet & Flash-Sale Engine

A production-grade backend for a digital wallet and a high-concurrency flash-sale
system, built with **NestJS**, **PostgreSQL (Prisma)**, and **Redis (BullMQ)**.

The core mission: hundreds of users can transfer money and buy from a very
limited stock at the same time, with **zero double-spending** and
**zero overselling**, no matter how many requests race each other.

**Modules**

- **Auth & RBAC** — JWT access tokens + rotating refresh tokens (stored in Redis), `CUSTOMER`/`ADMIN` roles.
- **Wallet & Ledger** — deposits, atomic peer-to-peer transfers, an immutable audit ledger.
- **Flash-Sale Engine** — admin-created limited-stock events, atomic stock reservation, wallet debit + compensating rollback, async order-confirmation notifications via BullMQ.
- **Observability** — structured Pino logs with correlation IDs, Redis-backed rate limiting, `/health` checks.

---

## Setup

### Prerequisites

- Docker + Docker Compose
- Node.js 20+ (only needed if you want to run things outside Docker, e.g. `npm run seed`)

### 1. Clone and configure

```bash
git clone <this-repo-url>
cd backend_assessment_challenge
cp .env.example .env
```

The defaults in `.env.example` already match the services defined in
`docker-compose.yml`, so no edits are required for a local run.

### 2. Build and run everything

```bash
docker compose up --build
```

This starts Postgres, Redis, and the app. On boot, the app container runs
`prisma migrate deploy` automatically (see `docker-entrypoint.sh`) before
starting the server — no manual migration step needed.

Once it's up:

- API base URL: `http://localhost:3000`
- Swagger UI: **http://localhost:3000/api/docs**
- Health check: **http://localhost:3000/health**
- Bull Board (queue admin UI, requires an ADMIN JWT): `http://localhost:3000/admin/queues`

To stop and wipe all data (fresh start):

```bash
docker compose down -v
```

### 3. Seed sample products (optional, for trying the flash-sale flow)

```bash
npm install
npm run seed
```

This inserts a handful of demo products directly via Prisma so you have a
`productId` to create a flash-sale event with.

### 4. Creating the first admin user

There is no public "create admin" endpoint — this is intentional (nobody should
be able to self-promote to `ADMIN` over the API). To create one:

1. Register normally:
   ```http
   POST /auth/register
   { "email": "admin@example.com", "password": "StrongP@ssw0rd" }
   ```
2. Promote that user's role directly in the database:
   ```sql
   UPDATE "User" SET role = 'ADMIN' WHERE email = 'admin@example.com';
   ```
   (e.g. `docker compose exec postgres psql -U postgres -d wallet_db -c "UPDATE \"User\" SET role='ADMIN' WHERE email='admin@example.com';"`)
3. Log in again (or refresh) to get a JWT carrying the new role — the role is
   embedded in the access token, so a token issued before the promotion still
   reflects the old role until it's reissued.

---

## Architectural Decisions

### Locking strategy for transfers — Pessimistic (`SELECT ... FOR UPDATE`)

Wallet deposits and transfers acquire row locks with raw `SELECT ... FOR UPDATE`
queries inside a Prisma `$transaction`, rather than optimistic locking
(version column + retry). Reasoning:

- Flash-sale/wallet contention is expected to be **high** on a small number of
  hot rows (popular wallets, popular flash-sale events) — optimistic locking
  would mean frequent retries and wasted work under exactly the load this
  system is designed for.
- The financial correctness requirement (never allow two concurrent transfers
  to read a stale balance) is easier to guarantee correct with a lock held for
  the duration of the check-then-write than with a compare-and-swap that has
  to be retried correctly everywhere balances are touched.
- **Deadlock avoidance**: for a two-wallet transfer, both rows are always
  locked in **ascending wallet-id order**, regardless of who is the sender or
  recipient. Two concurrent transfers moving money in opposite directions
  between the same pair of wallets therefore always attempt to acquire locks
  in the same order and can never deadlock each other.
- Balance sufficiency is checked **after** the lock is acquired, against the
  locked, up-to-date snapshot — never against a value read before locking.

### Overselling prevention (flash-sale stock)

Stock decrement is a single **atomic conditional UPDATE**, not a
read-then-write:

```sql
UPDATE "FlashSaleEvent"
SET remaining = remaining - 1
WHERE id = $1 AND remaining > 0
RETURNING remaining;
```

This is executed via `$queryRaw`. If no row comes back, the database itself
guaranteed no stock was available at that instant — the request fails cleanly
with `409 Conflict`, never with a `500` and never after having "reserved" a
unit that didn't exist. Because the check (`remaining > 0`) and the write
happen as one atomic statement at the database level, no application-level
lock is needed to prevent overselling, and it scales correctly under
arbitrarily high concurrency on the same row.

Reserving stock and debiting the wallet are then done as **two sequential
steps with a compensating action**, not one shared DB transaction:

- the flash-sale row lock (a single atomic UPDATE) and the wallet's own
  fixed-order pessimistic locking are kept independent, so the hot-path stock
  UPDATE is never held open waiting on wallet I/O;
- if the wallet debit fails after stock was reserved (e.g. insufficient
  balance), the reservation is released (`remaining + 1`) and a `FAILED`
  `Order` row is recorded for auditability — the customer is never charged
  for stock they didn't get, and the unit becomes available again immediately.

### Idempotency

Both the wallet and the flash-sale engine use the same **two-layer** pattern,
keyed off a client-supplied `idempotencyKey`:

1. **Fast path (Redis)** — `wallet:transfer:{userId}:{idempotencyKey}` /
   an equivalent flash-sale key, TTL 24h, caches the full result of the first
   successful call so an instant retry (e.g. a mobile client double-tapping
   "Pay") short-circuits without touching the database again.
2. **Source of truth (DB unique constraint)** — `LedgerEntry` has
   `@@unique([walletId, referenceId, type])`, and `Order` has
   `@@unique([flashSaleEventId, idempotencyKey])`. These are checked/relied on
   even if the Redis key is missing or was evicted, so idempotency holds even
   under Redis failure — a duplicate write raises a unique-constraint
   violation (`P2002`) that is treated as "a concurrent duplicate already won"
   rather than a real error, and the winner's existing result is returned.

For flash-sale purchases specifically, the wallet-ledger reference used for
the purchase deduction is **deterministic**
(`flash-sale:{eventId}:{idempotencyKey}`, not a random per-attempt order id),
so retries of the same logical purchase can never result in two wallet
deductions even if they race at the database level.

### Retry / backoff strategy (BullMQ)

Order-confirmation notifications are processed by a BullMQ worker configured
with:

- `attempts: 5`
- exponential backoff, `delay: 2000` (2s, 4s, 8s, 16s, 32s between attempts)
- `removeOnComplete: true`, `removeOnFail: false` (failed jobs are kept for
  inspection in Bull Board rather than silently discarded)

A final failure after all retries is only **logged** (`@OnWorkerEvent('failed')`)
— it never touches the `Order` or `Wallet` records, since a notification
failure must never be allowed to affect money or stock that has already been
correctly committed.

### Other notable trade-offs

- **RBAC guards are per-route (`@UseGuards`), not global.** Most of the app
  (health, Swagger, some read endpoints) doesn't require auth at all; applying
  guards explicitly per controller/route keeps that obvious from reading the
  controller instead of needing a global exclude-list.
- **`ThrottlerGuard` is global** (via `APP_GUARD`, Redis-backed storage), with
  route-level `@Throttle()` overrides where a route needs to be stricter
  (login: 5/min, flash-sale purchase: 3/s) or exempt (`@SkipThrottle()` on
  `/health`).
- **Money is stored as Prisma `Decimal`**, never a JS `number`/float, to avoid
  floating-point rounding errors in balances and ledger sums.
- **No public "create admin" or "promote user" endpoint** — the first admin is
  always created out-of-band (see Setup, step 4) so privilege escalation can
  never happen purely through the API surface.

---

## Running Tests

### Unit tests

```bash
npm run test
```

Covers business logic in the services: auth token issuance/rotation and
reuse-detection, wallet balance math and idempotent transfers, flash-sale
time-window/stock/rollback logic, and the notification worker's retry
branches.

Expected result:

```
Test Suites: 5 passed, 5 total
Tests:       32 passed, 32 total
```

### Concurrency test

With the stack running (`docker compose up`), from the host:

```bash
npm run test:concurrency
```

This boots a standalone Nest application context (bypassing the HTTP/rate-limit
layer on purpose, so a same-machine burst of requests doesn't get throttled
before it can exercise the actual race conditions) and drives
`FlashSaleService.purchase()` / `WalletService.transfer()` directly with
concurrent `Promise.all` bursts. It checks, and self-cleans before/after:

1. **Overselling**: 10 units of stock vs. 50 concurrent buyers → exactly 10
   `CONFIRMED` orders, 40 clean `409`-equivalent rejections, `remaining === 0`.
2. **Double-spending**: 20 concurrent transfers using the _same_
   `idempotencyKey` → the balance changes exactly once, exactly one
   `TRANSFER_OUT` ledger row is written.
3. **Ledger invariant**: for every wallet touched, `sum(LedgerEntry.amount) === Wallet.balance`.

Expected result (run 2–3 times to confirm it's deterministic, not lucky):

```
✅ Overselling test:  10 CONFIRMED / 40 rejected, remaining = 0
✅ Idempotency test:  balance change applied exactly once
✅ Ledger invariant:  holds for every touched wallet
ALL CONCURRENCY TESTS PASSED
```

---

## API Documentation

- **Swagger UI**: `http://localhost:3000/api/docs`
- **Health check**: `http://localhost:3000/health`
- **API collection** (REST Client `.http` format, covers auth/wallet/flash-sale
  with ready-made example bodies): [`docs/api-collection/wallet-flash-sale.http`](./docs/api-collection/wallet-flash-sale.http)
