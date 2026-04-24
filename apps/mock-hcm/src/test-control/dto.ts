import { Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsNumber,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';

export class SeedItemDto {
  @IsString()
  employeeId!: string;

  @IsString()
  locationId!: string;

  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Type(() => Number)
  balance!: number;
}

export class SeedDto {
  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => SeedItemDto)
  records!: SeedItemDto[];
}

export class AnniversaryDto {
  @IsString()
  employeeId!: string;

  @IsOptional()
  @IsString()
  locationId?: string;

  @IsNumber({ maxDecimalPlaces: 2 })
  @Type(() => Number)
  delta!: number;
}

export class YearStartDto {
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Type(() => Number)
  balance!: number;
}
