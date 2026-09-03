import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { PrismaService } from '../prisma/prisma.service';
import Redis from 'ioredis';
import { Inject } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { REDIS_CLIENT } from '../redis/redis.constants';
import { ORDER_NOTIFICATIONS_QUEUE } from '../modules/notifications/notifications.constants';

@ApiTags('health')
@Controller('health')
@SkipThrottle()
export class HealthController {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @InjectQueue(ORDER_NOTIFICATIONS_QUEUE)
    private readonly notificationsQueue: Queue,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Check service, database, redis and queue health' })
  @ApiResponse({
    status: 200,
    description: '{ status: "ok" | "degraded", db, redis, queue }',
  })
  async check() {
    const [db, redis, queue] = await Promise.all([
      this.prisma.isHealthy(),
      this.checkRedis(),
      this.checkQueue(),
    ]);

    return {
      status: db && redis && queue ? 'ok' : 'degraded',
      db,
      redis,
      queue,
    };
  }

  private async checkRedis(): Promise<boolean> {
    try {
      const pong = await this.redis.ping();
      return pong === 'PONG';
    } catch {
      return false;
    }
  }

  /** Confirms the `order-notifications` BullMQ queue can actually reach Redis. */
  private async checkQueue(): Promise<boolean> {
    try {
      await this.notificationsQueue.getJobCounts();
      return true;
    } catch {
      return false;
    }
  }
}
