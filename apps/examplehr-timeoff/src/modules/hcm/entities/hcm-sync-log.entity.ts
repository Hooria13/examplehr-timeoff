import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
} from 'typeorm';

export enum HcmSyncStatus {
  RUNNING = 'RUNNING',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
}

@Entity('hcm_sync_log')
export class HcmSyncLog {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @CreateDateColumn({ name: 'started_at' })
  startedAt!: Date;

  @Column({ name: 'finished_at', type: 'datetime', nullable: true })
  finishedAt!: Date | null;

  @Column({ name: 'records_seen', type: 'integer', default: 0 })
  recordsSeen!: number;

  @Column({ name: 'drift_count', type: 'integer', default: 0 })
  driftCount!: number;

  @Column({ type: 'text', default: HcmSyncStatus.RUNNING })
  status!: HcmSyncStatus;

  @Column({ type: 'text', nullable: true })
  error!: string | null;

  @Column({ type: 'simple-json', nullable: true })
  summary!: Record<string, unknown> | null;
}
