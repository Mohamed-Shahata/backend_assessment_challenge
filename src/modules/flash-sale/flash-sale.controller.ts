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
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
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
  createEvent(@Body() dto: CreateFlashSaleEventDto) {
    return this.flashSaleService.createEvent(dto);
  }

  @Get('events/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: "[ADMIN] Get an event's status and current stock" })
  getEvent(@Param('id', ParseUUIDPipe) id: string) {
    return this.flashSaleService.getEvent(id);
  }

  @Post('purchase')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard, ThrottlerGuard)
  // Stricter than the app-wide default (10 req / 60s) - flash-sale purchase
  // is the hottest, highest-contention route in the system. Task 06 will
  // tune this further as part of general observability/resilience work.
  @Throttle({ default: { limit: 3, ttl: 1000 } })
  @ApiOperation({
    summary:
      'Purchase one unit from a flash-sale event (idempotent via idempotencyKey)',
  })
  purchase(
    @CurrentUser() user: CurrentUserPayload,
    @Body() dto: PurchaseFlashSaleDto,
  ) {
    return this.flashSaleService.purchase(user.userId, dto);
  }
}
