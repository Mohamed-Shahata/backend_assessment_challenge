import { ApiProperty } from '@nestjs/swagger';
import {
  IsNotEmpty,
  IsNumber,
  IsPositive,
  IsString,
  IsUUID,
} from 'class-validator';

export class TransferDto {
  @ApiProperty({ description: 'Recipient user id' })
  @IsUUID()
  toUserId!: string;

  @ApiProperty({
    example: 25.0,
    description: 'Amount to transfer (max 2 decimals)',
  })
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  amount!: number;

  @ApiProperty({
    example: 'a2f0c8f2-6e3b-4b5a-9b0a-4b6f9a1e2d3c',
    description:
      'Client-generated key; resending the same key returns the original result instead of transferring again',
  })
  @IsString()
  @IsNotEmpty()
  idempotencyKey!: string;
}
