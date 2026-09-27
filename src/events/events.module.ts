import { Module } from '@nestjs/common';
import { EventModelModule } from './event-model.module';
import { EventsController } from './events.controller';
import { EventsRepository } from './events.repository';
import { IngestService } from './ingest.service';

@Module({
  imports: [EventModelModule],
  controllers: [EventsController],
  providers: [IngestService, EventsRepository],
})
export class EventsModule {}
