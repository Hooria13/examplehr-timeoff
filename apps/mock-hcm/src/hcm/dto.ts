import { Type } from 'class-transformer';
import {
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  Min,
} from 'class-validator';

export class DeductDto {
  @IsString()
  employeeId!: string;

  @IsString()
  locationId!: string;

  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  @Type(() => Number)
  days!: number;

  @IsString()
  idempotencyKey!: string;
}

export class ReverseDto {
  @IsString()
  employeeId!: string;

  @IsString()
  locationId!: string;

  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  @Type(() => Number)
  days!: number;

  @IsString()
  idempotencyKey!: string;
}

export class BatchQueryDto {
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  page?: number;

  @IsOptional()
  @IsNumber()
  @Min(1)
  @Type(() => Number)
  limit?: number;
}

export interface BalanceResponse {
  employeeId: string;
  locationId: string;
  balance: number;
  updatedAt: string;
}

export interface BatchResponse {
  page: number;
  limit: number;
  total: number;
  items: BalanceResponse[];
}

export interface DeductResponse {
  employeeId: string;
  locationId: string;
  newBalance: number;
  idempotencyKey: string;
  appliedAt: string;
}
