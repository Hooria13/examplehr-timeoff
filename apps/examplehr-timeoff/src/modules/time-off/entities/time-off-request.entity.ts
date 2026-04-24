import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { numericTransformer } from '../../../common/numeric-transformer';

export enum TimeOffStatus {
  SUBMITTED = 'SUBMITTED',
  APPROVING = 'APPROVING',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
  REJECTED_BY_HCM = 'REJECTED_BY_HCM',
  CANCELLATION_REQUESTED = 'CANCELLATION_REQUESTED',
  CANCELLED = 'CANCELLED',
  EXPIRED = 'EXPIRED',
  INDETERMINATE = 'INDETERMINATE',
}

export const TERMINAL_STATUSES: ReadonlySet<TimeOffStatus> = new Set([
  TimeOffStatus.APPROVED,
  TimeOffStatus.REJECTED,
  TimeOffStatus.REJECTED_BY_HCM,
  TimeOffStatus.CANCELLED,
  TimeOffStatus.EXPIRED,
]);

@Entity('time_off_requests')
@Index('ix_request_employee_status', ['employeeId', 'status'])
export class TimeOffRequest {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'employee_id', type: 'text' })
  employeeId!: string;

  @Column({ name: 'location_id', type: 'text' })
  locationId!: string;

  @Column({ name: 'start_date', type: 'date' })
  startDate!: string;

  @Column({ name: 'end_date', type: 'date' })
  endDate!: string;

  @Column({
    name: 'days',
    type: 'decimal',
    precision: 10,
    scale: 2,
    transformer: numericTransformer,
  })
  days!: number;

  @Column({ type: 'text', default: TimeOffStatus.SUBMITTED })
  status!: TimeOffStatus;

  @Column({ name: 'submitted_by', type: 'text' })
  submittedBy!: string;

  @Column({ name: 'decided_by', type: 'text', nullable: true })
  decidedBy!: string | null;

  @Column({ type: 'text', nullable: true })
  reason!: string | null;

  @Column({ name: 'decision_notes', type: 'text', nullable: true })
  decisionNotes!: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;
}
