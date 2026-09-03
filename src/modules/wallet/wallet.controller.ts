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
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
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
  @ApiResponse({
    status: 200,
    description: 'Updated wallet balance + ledger entry created',
  })
  @ApiResponse({
    status: 400,
    description: 'Validation error (amount must be positive, max 2 decimals)',
  })
  @ApiResponse({ status: 401, description: 'Missing or invalid access token' })
  @ApiResponse({ status: 404, description: 'Wallet not found for this user' })
  deposit(@CurrentUser() user: CurrentUserPayload, @Body() dto: DepositDto) {
    return this.walletService.deposit(user.userId, dto);
  }

  @Post('transfer')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Atomically transfer funds to another user (idempotent via idempotencyKey)',
  })
  @ApiResponse({
    status: 200,
    description:
      'Transfer applied (or replayed from a matching idempotencyKey)',
  })
  @ApiResponse({
    status: 400,
    description:
      'Validation error, insufficient balance, or self-transfer attempt',
  })
  @ApiResponse({ status: 401, description: 'Missing or invalid access token' })
  @ApiResponse({
    status: 404,
    description: 'Sender or recipient wallet not found',
  })
  @ApiResponse({
    status: 409,
    description:
      'Concurrent duplicate request with the same idempotencyKey already in flight',
  })
  transfer(@CurrentUser() user: CurrentUserPayload, @Body() dto: TransferDto) {
    return this.walletService.transfer(user.userId, dto);
  }

  @Get('me')
  @ApiOperation({
    summary: "Current user's balance and most recent ledger entries",
  })
  @ApiResponse({
    status: 200,
    description: 'Balance and last N ledger entries (default 20)',
  })
  @ApiResponse({ status: 401, description: 'Missing or invalid access token' })
  @ApiResponse({ status: 404, description: 'Wallet not found for this user' })
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
