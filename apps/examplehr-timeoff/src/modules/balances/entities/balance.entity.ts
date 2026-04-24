import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
  VersionColumn,
} from 'typeorm';
import { numericTransformer } from '../../../common/numeric-transformer';

@Entity('balances')
@Index('uq_balance_employee_location', ['employeeId', 'locationId'], {
  unique: true,
})
export class Balance {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'employee_id', type: 'text' })
  employeeId!: string;

  @Column({ name: 'location_id', type: 'text' })
  locationId!: string;

  @Column({
    name: 'hcm_balance',
    type: 'decimal',
    precision: 10,
    scale: 2,
    default: 0,
    transformer: numericTransformer,
  })
  hcmBalance!: number;

  @Column({
    name: 'pending_at_hcm',
    type: 'decimal',
    precision: 10,
    scale: 2,
    default: 0,
    transformer: numericTransformer,
  })
  pendingAtHcm!: number;

  @Column({
    name: 'local_holds',
    type: 'decimal',
    precision: 10,
    scale: 2,
    default: 0,
    transformer: numericTransformer,
  })
  localHolds!: number;

  @Column({ name: 'hcm_synced_at', type: 'datetime', nullable: true })
  hcmSyncedAt!: Date | null;

  @VersionColumn()
  version!: number;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;
}
