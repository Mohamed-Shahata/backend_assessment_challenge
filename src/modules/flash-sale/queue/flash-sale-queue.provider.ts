import { Logger, Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import {
  FLASH_SALE_QUEUE,
  FLASH_SALE_QUEUE_NAME,
} from './flash-sale-queue.constants';

const logger = new Logger('FlashSaleQueue');

/**
 * Minimal BullMQ producer so task 04 can enqueue order-notification jobs.
 * Task 05 (queues-notifications) owns the actual worker/processor and may
 * reshape this provider as part of its own queue module.
 */
export const flashSaleQueueProvider: Provider = {
  provide: FLASH_SALE_QUEUE,
  inject: [ConfigService],
  useFactory: (config: ConfigService) => {
    const queue = new Queue(FLASH_SALE_QUEUE_NAME, {
      connection: {
        host: config.get<string>('redis.host'),
        port: config.get<number>('redis.port'),
      },
    });

    queue.on('error', (err) => {
      logger.error(`Flash-sale queue connection error: ${err.message}`);
    });

    return queue;
  },
};
