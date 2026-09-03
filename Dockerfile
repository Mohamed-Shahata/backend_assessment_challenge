# syntax=docker/dockerfile:1

FROM node:22-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

RUN npx prisma generate
RUN npm run build


FROM node:22-alpine AS runner

ENV NODE_ENV=production
WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts

# Prisma CLI is a devDependency (by design, so it isn't shipped as an app
# runtime dependency) but `prisma migrate deploy` in the entrypoint still
# needs it available at container startup -> bring it over from builder.
# `dotenv` is only a *transitive* devDependency (of `prisma`, marked
# "devOptional" in package-lock.json) so `npm ci --omit=dev` skips it too,
# but prisma.config.ts does `import 'dotenv/config'` unconditionally -> the
# CLI would crash on startup without it, so it has to come along as well.
COPY --from=builder /app/node_modules/prisma ./node_modules/prisma
COPY --from=builder /app/node_modules/.bin/prisma ./node_modules/.bin/prisma
COPY --from=builder /app/node_modules/dotenv ./node_modules/dotenv

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/prisma.config.ts ./prisma.config.ts

COPY docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x ./docker-entrypoint.sh

EXPOSE 3000

ENTRYPOINT ["./docker-entrypoint.sh"]