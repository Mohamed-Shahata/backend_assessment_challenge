#!/bin/sh
set -e

echo "[entrypoint] running database migrations (prisma migrate deploy)..."
npx prisma migrate deploy

echo "[entrypoint] starting app..."
exec node dist/src/main.js