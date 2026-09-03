import type { Job } from 'bullmq';
import { OrderNotificationProcessor } from './order-notification.processor';
import {
  ORDER_CONFIRMATION_JOB,
  type OrderConfirmationJobData,
} from './notifications.constants';

describe('OrderNotificationProcessor', () => {
  let processor: OrderNotificationProcessor;
  let config: { get: jest.Mock };
  let randomSpy: jest.SpyInstance;

  const job = (
    over: Partial<Job<OrderConfirmationJobData, void, string>> = {},
  ): Job<OrderConfirmationJobData, void, string> =>
    ({
      name: ORDER_CONFIRMATION_JOB,
      data: { orderId: 'order-1', userId: 'user-1' },
      attemptsMade: 0,
      opts: { attempts: 5 },
      ...over,
    }) as Job<OrderConfirmationJobData, void, string>;

  beforeEach(() => {
    jest.useFakeTimers();
    config = { get: jest.fn().mockReturnValue(0) };
    processor = new OrderNotificationProcessor(config as never);
    randomSpy = jest.spyOn(Math, 'random');
  });

  afterEach(() => {
    jest.useRealTimers();
    randomSpy.mockRestore();
  });

  const runProcess = (j: Job<OrderConfirmationJobData, void, string>) => {
    const promise = processor.process(j);
    jest.runAllTimers();
    return promise;
  };

  describe('process', () => {
    it('completes without throwing when the failure rate is 0', async () => {
      config.get.mockReturnValue(0);
      await expect(runProcess(job())).resolves.toBeUndefined();
    });

    it('ignores jobs with an unknown name', async () => {
      randomSpy.mockReturnValue(0); // would "fail" if reached
      await expect(
        runProcess(job({ name: 'some-other-job' })),
      ).resolves.toBeUndefined();
    });

    it('throws to trigger a BullMQ retry when the simulated failure hits', async () => {
      config.get.mockReturnValue(1); // always fail
      randomSpy.mockReturnValue(0);

      await expect(runProcess(job())).rejects.toThrow(
        /Simulated notification failure for order=order-1/,
      );
    });

    it('does not simulate failure when the configured rate is not reached', async () => {
      config.get.mockReturnValue(0.5);
      randomSpy.mockReturnValue(0.9); // above the threshold

      await expect(runProcess(job())).resolves.toBeUndefined();
    });
  });

  describe('onFailed', () => {
    let errorSpy: jest.SpyInstance;
    let warnSpy: jest.SpyInstance;

    beforeEach(() => {
      errorSpy = jest
        .spyOn(processor['logger'], 'error')
        .mockImplementation(() => undefined);
      warnSpy = jest
        .spyOn(processor['logger'], 'warn')
        .mockImplementation(() => undefined);
    });

    it('logs a warning (not an error) when attempts remain', () => {
      processor.onFailed(job({ attemptsMade: 2 }), new Error('boom'));
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('will retry'),
      );
      expect(errorSpy).not.toHaveBeenCalled();
    });

    it('logs an error (permanent failure) once attempts are exhausted', () => {
      processor.onFailed(
        job({ attemptsMade: 5, opts: { attempts: 5 } }),
        new Error('boom'),
      );
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('permanently failed'),
      );
    });

    it('never throws, even with no job context', () => {
      expect(() =>
        processor.onFailed(undefined, new Error('boom')),
      ).not.toThrow();
      expect(errorSpy).toHaveBeenCalled();
    });
  });
});
