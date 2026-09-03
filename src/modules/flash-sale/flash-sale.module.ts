import { Module } from '@nestjs/common';
import { WalletModule } from '../wallet/wallet.module';
import { FlashSaleController } from './flash-sale.controller';
import { FlashSaleService } from './flash-sale.service';
import { flashSaleQueueProvider } from './queue/flash-sale-queue.provider';

@Module({
  imports: [WalletModule],
  controllers: [FlashSaleController],
  providers: [FlashSaleService, flashSaleQueueProvider],
  exports: [FlashSaleService],
})
export class FlashSaleModule {}
