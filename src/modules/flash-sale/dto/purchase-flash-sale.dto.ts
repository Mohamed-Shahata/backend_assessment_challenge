import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, IsUUID } from 'class-validator';

export class PurchaseFlashSaleDto {
  @ApiProperty({ description: 'Id of the flash-sale event to purchase from' })
  @IsUUID()
  eventId!: string;

  @ApiProperty({
    example: 'a2f0c8f2-6e3b-4b5a-9b0a-4b6f9a1e2d3c',
    description:
      'Client-generated key; resending the same key for the same event returns the original order instead of reserving another unit',
  })
  @IsString()
  @IsNotEmpty()
  idempotencyKey!: string;
}
