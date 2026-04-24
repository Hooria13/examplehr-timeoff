import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Balance } from '../modules/balances/entities/balance.entity';
import { HcmOutbox } from '../modules/hcm/entities/hcm-outbox.entity';
import { HcmSyncLog } from '../modules/hcm/entities/hcm-sync-log.entity';
import { TimeOffRequest } from '../modules/time-off/entities/time-off-request.entity';

export const ENTITIES = [Balance, TimeOffRequest, HcmOutbox, HcmSyncLog];

@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'better-sqlite3',
        database: config.get<string>('DB_PATH') ?? ':memory:',
        entities: ENTITIES,
        synchronize: true,
        logging: config.get<string>('DB_LOGGING') === 'true',
      }),
    }),
  ],
})
export class DatabaseModule {}
