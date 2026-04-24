import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export enum HcmOutboxOp {
  DEDUCT = 'DEDUCT',
  REVERSE = 'REVERSE',
  GET_BALANCE = 'GET_BALANCE',
}

export enum HcmOutboxStatus {
  PENDING = 'PENDING',
  IN_FLIGHT = 'IN_FLIGHT',
  SUCCEEDED = 'SUCCEEDED',
  CONFIRMED = 'CONFIRMED',
  FAILED_RETRYABLE = 'FAILED_RETRYABLE',
  FAILED_TERMINAL = 'FAILED_TERMINAL',
}

@Entity('hcm_outbox')
@Index('ix_outbox_status_next_attempt', ['status', 'nextAttemptAt'])
@Index('ix_outbox_correlation', ['correlationId'])
export class HcmOutbox {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'text' })
  op!: HcmOutboxOp;

  @Column({ type: 'simple-json' })
  payload!: Record<string, unknown>;

  @Column({ type: 'text', default: HcmOutboxStatus.PENDING })
  status!: HcmOutboxStatus;

  @Column({ type: 'integer', default: 0 })
  attempts!: number;

  @Column({ name: 'next_attempt_at', type: 'datetime' })
  nextAttemptAt!: Date;

  @Column({ name: 'last_error', type: 'text', nullable: true })
  lastError!: string | null;

  @Column({ name: 'correlation_id', type: 'text', nullable: true })
  correlationId!: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;
}
