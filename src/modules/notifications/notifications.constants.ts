export const ORDER_NOTIFICATIONS_QUEUE = 'order-notifications';
export const ORDER_CONFIRMATION_JOB = 'order-confirmation';

/** Default BullMQ job options for `order-confirmation` jobs, per task 05's spec. */
export const ORDER_CONFIRMATION_JOB_OPTIONS = {
  attempts: 5,
  backoff: { type: 'exponential' as const, delay: 2000 },
  removeOnComplete: true,
  removeOnFail: false,
};

export interface OrderConfirmationJobData {
  orderId: string;
  userId: string;
}
