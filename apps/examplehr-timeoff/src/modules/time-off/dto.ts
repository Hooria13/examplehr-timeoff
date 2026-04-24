import { IsISO8601, IsOptional, IsString, MaxLength } from 'class-validator';

export class SubmitRequestDto {
  @IsString()
  employeeId!: string;

  @IsString()
  locationId!: string;

  @IsISO8601({ strict: true })
  startDate!: string;

  @IsISO8601({ strict: true })
  endDate!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class DecisionDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}

export interface TimeOffRequestDto {
  id: string;
  employeeId: string;
  locationId: string;
  startDate: string;
  endDate: string;
  days: number;
  status: string;
  submittedBy: string;
  decidedBy: string | null;
  reason: string | null;
  decisionNotes: string | null;
  createdAt: string;
  updatedAt: string;
}
