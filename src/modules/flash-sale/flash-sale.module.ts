import { Module } from '@nestjs/common';
import { WalletModule } from '../wallet/wallet.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { FlashSaleController } from './flash-sale.controller';
import { FlashSaleService } from './flash-sale.service';

@Module({
  imports: [WalletModule, NotificationsModule],
  controllers: [FlashSaleController],
  providers: [FlashSaleService],
  exports: [FlashSaleService],
})
export class FlashSaleModule {}
