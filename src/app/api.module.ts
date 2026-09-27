import { Module } from '@nestjs/common';
import { ConfigModule } from '../config/config.module';
import { DatabaseModule } from '../database/database.module';
import { HealthController } from './health.controller';

@Module({
  imports: [ConfigModule, DatabaseModule],
  controllers: [HealthController],
})
export class ApiModule {}
