import { Module } from '@nestjs/common';
import { ConfigModule } from '../config/config.module';
import { DatabaseModule } from '../database/database.module';
import { EventModelModule } from '../events/event-model.module';

@Module({
  imports: [ConfigModule, DatabaseModule, EventModelModule],
})
export class WorkerModule {}
