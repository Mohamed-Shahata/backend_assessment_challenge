import { ApiProperty } from '@nestjs/swagger';
import { IsDateString, IsInt, IsUUID, Min } from 'class-validator';

export class CreateFlashSaleEventDto {
  @ApiProperty({ description: 'Id of the product being sold' })
  @IsUUID()
  productId!: string;

  @ApiProperty({ example: 10, description: 'Units available for this event' })
  @IsInt()
  @Min(1)
  totalStock!: number;

  @ApiProperty({ example: '2026-09-02T12:00:00.000Z' })
  @IsDateString()
  startsAt!: string;

  @ApiProperty({ example: '2026-09-02T13:00:00.000Z' })
  @IsDateString()
  endsAt!: string;
}
