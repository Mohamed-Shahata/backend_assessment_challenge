import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { BullModule } from '@nestjs/bullmq';
import { BullBoardModule } from '@bull-board/nestjs';
import { ExpressAdapter } from '@bull-board/express';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { BullBoardAdminMiddleware } from './bull-board-admin.middleware';
import { OrderNotificationProcessor } from './order-notification.processor';
import { ORDER_NOTIFICATIONS_QUEUE } from './notifications.constants';

/** Route where Bull Board (job monitoring UI) is mounted, protected by `BullBoardAdminMiddleware`. */
export const BULL_BOARD_ROUTE = '/admin/queues';

@Module({
  imports: [
    BullModule.registerQueue({ name: ORDER_NOTIFICATIONS_QUEUE }),
    BullBoardModule.forRoot({
      route: BULL_BOARD_ROUTE,
      adapter: ExpressAdapter,
    }),
    BullBoardModule.forFeature({
      name: ORDER_NOTIFICATIONS_QUEUE,
      adapter: BullMQAdapter,
    }),
    // JwtModule.register({}) so BullBoardAdminMiddleware can inject JwtService
    // to verify tokens with an explicit secret (see the middleware).
    JwtModule.register({}),
  ],
  providers: [OrderNotificationProcessor],
  exports: [BullModule],
})
export class NotificationsModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(BullBoardAdminMiddleware).forRoutes(BULL_BOARD_ROUTE);
  }
}
