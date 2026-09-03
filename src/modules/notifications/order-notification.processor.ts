import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import {
  ORDER_CONFIRMATION_JOB,
  ORDER_NOTIFICATIONS_QUEUE,
  type OrderConfirmationJobData,
} from './notifications.constants';

/**
 * Worker for the `order-notifications` queue. Purely a mock/simulation:
 * there is no real email/SMS/push provider here, only a logged
 * "notification sent" (or a thrown error to trigger BullMQ's retry).
 *
 * Fully decoupled from the purchase flow: this processor never touches the
 * Order or Wallet - a failure here only affects the notification job itself.
 */
@Processor(ORDER_NOTIFICATIONS_QUEUE)
export class OrderNotificationProcessor extends WorkerHost {
  private readonly logger = new Logger(OrderNotificationProcessor.name);

  constructor(private readonly config: ConfigService) {
    super();
  }

  async process(
    job: Job<OrderConfirmationJobData, void, string>,
  ): Promise<void> {
    if (job.name !== ORDER_CONFIRMATION_JOB) {
      this.logger.warn(
        `Ignoring unknown job "${job.name}" on ${ORDER_NOTIFICATIONS_QUEUE}`,
      );
      return;
    }

    const { orderId, userId } = job.data;

    // Simulate the latency of an actual notification provider call.
    await this.delay(200);

    if (this.shouldSimulateFailure()) {
      throw new Error(
        `Simulated notification failure for order=${orderId} (attempt ${job.attemptsMade + 1})`,
      );
    }

    this.logger.log(
      `Notification sent for order=${orderId} user=${userId} (attempt ${job.attemptsMade + 1})`,
    );
  }

  /** Logs, but never throws: a permanently-failed notification must not crash the server. */
  @OnWorkerEvent('failed')
  onFailed(job: Job<OrderConfirmationJobData> | undefined, err: Error): void {
    if (!job) {
      this.logger.error(
        `Order-notification job failed with no job context: ${err.message}`,
      );
      return;
    }

    const maxAttempts = job.opts.attempts ?? 1;
    if (job.attemptsMade >= maxAttempts) {
      this.logger.error(
        `Notification for order=${job.data.orderId} permanently failed after ${job.attemptsMade} attempts: ${err.message}`,
      );
    } else {
      this.logger.warn(
        `Notification attempt ${job.attemptsMade} failed for order=${job.data.orderId}, will retry: ${err.message}`,
      );
    }
  }

  /**
   * Controllable via `SIMULATE_NOTIFICATION_FAILURE_RATE` (0..1, default 0)
   * so the retry/backoff behavior can actually be exercised in dev.
   */
  private shouldSimulateFailure(): boolean {
    const rate = this.config.get<number>(
      'notifications.simulateFailureRate',
      0,
    );
    if (!rate || rate <= 0) {
      return false;
    }
    return Math.random() < rate;
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
