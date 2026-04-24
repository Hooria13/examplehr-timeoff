import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsPositive,
  Min,
} from 'class-validator';

export class RegisterFaultDto {
  @IsIn(['balance', 'deduct', 'reverse', 'batch'])
  op!: 'balance' | 'deduct' | 'reverse' | 'batch';

  @IsIn(['error500', 'throttle', 'timeout', 'silent-accept'])
  mode!: 'error500' | 'throttle' | 'timeout' | 'silent-accept';

  @IsOptional()
  @IsInt()
  @IsPositive()
  remainingTriggers?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Type(() => Number)
  timeoutMs?: number;
}
