import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import type { CurrentUserPayload } from '../../auth/interfaces/jwt-payload.interface';
import { DepositDto } from './dto/deposit.dto';
import { TransferDto } from './dto/transfer.dto';
import { WalletService } from './wallet.service';

@ApiTags('wallets')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('wallets')
export class WalletController {
  constructor(private readonly walletService: WalletService) {}

  @Post('deposit')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Add funds to the current user's wallet" })
  deposit(@CurrentUser() user: CurrentUserPayload, @Body() dto: DepositDto) {
    return this.walletService.deposit(user.userId, dto);
  }

  @Post('transfer')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Atomically transfer funds to another user (idempotent via idempotencyKey)',
  })
  transfer(@CurrentUser() user: CurrentUserPayload, @Body() dto: TransferDto) {
    return this.walletService.transfer(user.userId, dto);
  }

  @Get('me')
  @ApiOperation({
    summary: "Current user's balance and most recent ledger entries",
  })
  getMe(
    @CurrentUser() user: CurrentUserPayload,
    @Query('limit') limit?: string,
  ) {
    return this.walletService.getMe(
      user.userId,
      limit ? parseInt(limit, 10) : undefined,
    );
  }
}
