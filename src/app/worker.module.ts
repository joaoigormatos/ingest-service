import { Module } from '@nestjs/common';
import { CommonModule } from '../common/common.module';
import { ConfigModule } from '../config/config.module';
import { DatabaseModule } from '../database/database.module';
import { ProcessingModule } from '../processing/processing.module';

@Module({
  imports: [ConfigModule, CommonModule, DatabaseModule, ProcessingModule],
})
export class WorkerModule {}
