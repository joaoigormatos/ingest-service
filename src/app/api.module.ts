import { Module } from '@nestjs/common';
import { CommonModule } from '../common/common.module';
import { ConfigModule } from '../config/config.module';
import { DatabaseModule } from '../database/database.module';
import { EventsModule } from '../events/events.module';
import { StatsModule } from '../stats/stats.module';
import { HealthController } from './health.controller';

@Module({
  imports: [ConfigModule, CommonModule, DatabaseModule, EventsModule, StatsModule],
  controllers: [HealthController],
})
export class ApiModule {}
