import { Module } from '@nestjs/common';
import { EventModelModule } from '../events/event-model.module';
import { StatsController } from './stats.controller';
import { StatsRepository } from './stats.repository';

@Module({
  imports: [EventModelModule],
  controllers: [StatsController],
  providers: [StatsRepository],
})
export class StatsModule {}
