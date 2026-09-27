import { Module } from '@nestjs/common';
import { EventModelModule } from '../events/event-model.module';
import { ClaimRepository } from './claim.repository';
import { FakeExternalProcessor } from './fake-external.processor';
import { PROCESSOR } from './processor';
import { WorkerService } from './worker.service';

@Module({
  imports: [EventModelModule],
  providers: [
    ClaimRepository,
    WorkerService,
    { provide: PROCESSOR, useClass: FakeExternalProcessor },
  ],
})
export class ProcessingModule {}
