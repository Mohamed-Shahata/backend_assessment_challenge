export const ORDER_NOTIFICATIONS_QUEUE = 'order-notifications';
export const ORDER_CONFIRMATION_JOB = 'order-confirmation';

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
