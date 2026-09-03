import { ApiProperty } from '@nestjs/swagger';
import { IsDateString, IsInt, IsUUID, Min } from 'class-validator';
import { IsAfterDate } from '../../../common/validators/is-after-date.validator';
import { IsNotPastDate } from '../../../common/validators/is-not-past-date.validator';

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
  @IsNotPastDate({ message: 'startsAt cannot be in the past' })
  startsAt!: string;

  @ApiProperty({ example: '2026-09-02T13:00:00.000Z' })
  @IsDateString()
  @IsNotPastDate({ message: 'endsAt cannot be in the past' })
  @IsAfterDate('startsAt', { message: 'endsAt must be after startsAt' })
  endsAt!: string;
}
