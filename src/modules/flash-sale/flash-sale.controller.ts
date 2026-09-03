import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { Roles } from '../../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import type { CurrentUserPayload } from '../../auth/interfaces/jwt-payload.interface';
import { Role } from '../../generated/prisma/enums';
import { CreateFlashSaleEventDto } from './dto/create-flash-sale-event.dto';
import { PurchaseFlashSaleDto } from './dto/purchase-flash-sale.dto';
import { FlashSaleService } from './flash-sale.service';

@ApiTags('flash-sale')
@ApiBearerAuth()
@Controller('flash-sale')
export class FlashSaleController {
  constructor(private readonly flashSaleService: FlashSaleService) {}

  @Post('events')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: '[ADMIN] Create a flash-sale event' })
  @ApiResponse({ status: 201, description: 'Flash-sale event created' })
  @ApiResponse({
    status: 400,
    description:
      'Validation error (bad dates, non-positive stock, endsAt before startsAt)',
  })
  @ApiResponse({ status: 401, description: 'Missing or invalid access token' })
  @ApiResponse({ status: 403, description: 'Authenticated but not an ADMIN' })
  @ApiResponse({
    status: 404,
    description: 'productId does not match an existing product',
  })
  createEvent(@Body() dto: CreateFlashSaleEventDto) {
    return this.flashSaleService.createEvent(dto);
  }

  @Get('events/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: "[ADMIN] Get an event's status and current stock" })
  @ApiResponse({
    status: 200,
    description: 'Event details including remaining stock',
  })
  @ApiResponse({ status: 401, description: 'Missing or invalid access token' })
  @ApiResponse({ status: 403, description: 'Authenticated but not an ADMIN' })
  @ApiResponse({ status: 404, description: 'Flash-sale event not found' })
  getEvent(@Param('id', ParseUUIDPipe) id: string) {
    return this.flashSaleService.getEvent(id);
  }

  @Post('purchase')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  // Stricter than the app-wide default (10 req / 60s) - flash-sale purchase
  // is the hottest, highest-contention route in the system - but still
  // generous enough (3 req/s = up to 180/min per user) to not choke a real
  // user rapid-retrying during a flash sale. `ThrottlerGuard` itself is now
  // applied globally (`APP_GUARD` in AppModule) with Redis-backed storage,
  // this decorator only overrides the limit for this route.
  @Throttle({ default: { limit: 3, ttl: 1000 } })
  @ApiOperation({
    summary:
      'Purchase one unit from a flash-sale event (idempotent via idempotencyKey)',
  })
  @ApiResponse({
    status: 200,
    description: 'Order confirmed (or replayed from a matching idempotencyKey)',
  })
  @ApiResponse({
    status: 400,
    description:
      'Validation error, event not currently active, or insufficient wallet balance',
  })
  @ApiResponse({ status: 401, description: 'Missing or invalid access token' })
  @ApiResponse({ status: 404, description: 'Flash-sale event not found' })
  @ApiResponse({
    status: 409,
    description:
      'Sold out (no remaining stock) or a concurrent duplicate request already won',
  })
  @ApiResponse({
    status: 429,
    description: 'Too many purchase attempts (rate limited)',
  })
  purchase(
    @CurrentUser() user: CurrentUserPayload,
    @Body() dto: PurchaseFlashSaleDto,
  ) {
    return this.flashSaleService.purchase(user.userId, dto);
  }
}
