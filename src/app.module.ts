import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { BullModule } from '@nestjs/bullmq';
import { LoggerModule } from 'nestjs-pino';
import Redis from 'ioredis';
import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import appConfig from './config/app-config';
import { validate } from './config/env.validation';
import { PrismaModule } from './prisma/prisma.module';
import { RedisModule } from './redis/redis.module';
import { REDIS_CLIENT } from './redis/redis.constants';
import { HealthModule } from './health/health.module';
import { CorrelationIdMiddleware } from './common/middleware/correlation-id.middleware';
import { createPinoLoggerConfig } from './common/logger/pino-logger.config';
import { AuthModule } from './auth/auth.module';
import { WalletModule } from './modules/wallet/wallet.module';
import { FlashSaleModule } from './modules/flash-sale/flash-sale.module';
import { NotificationsModule } from './modules/notifications/notifications.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [appConfig],
      validate,
      envFilePath: '.env',
    }),
    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: createPinoLoggerConfig,
    }),
    ThrottlerModule.forRootAsync({
      inject: [REDIS_CLIENT],
      useFactory: (redis: Redis) => ({
        throttlers: [
          {
            ttl: parseInt(process.env.THROTTLE_TTL ?? '60', 10) * 1000,
            limit: parseInt(process.env.THROTTLE_LIMIT ?? '10', 10),
          },
        ],
        // Redis-backed storage (instead of the default in-memory map) so
        // rate limits are enforced consistently across multiple app
        // instances/replicas.
        storage: new ThrottlerStorageRedisService(redis),
      }),
    }),
    BullModule.forRootAsync({
      useFactory: (config: ConfigService) => ({
        connection: {
          host: config.get<string>('redis.host'),
          port: config.get<number>('redis.port'),
        },
      }),
      inject: [ConfigService],
    }),
    PrismaModule,
    RedisModule,
    HealthModule,
    AuthModule,
    WalletModule,
    FlashSaleModule,
    NotificationsModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    // Global rate limiting: every route is throttled by default (see
    // ThrottlerModule config above); individual routes fine-tune this with
    // `@Throttle()` / opt out with `@SkipThrottle()`.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(CorrelationIdMiddleware).forRoutes('*');
  }
}
