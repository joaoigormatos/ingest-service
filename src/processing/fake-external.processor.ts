import { Inject, Injectable } from '@nestjs/common';
import { setTimeout as sleep } from 'node:timers/promises';
import { APP_CONFIG, AppConfig } from '../config/config';
import { Processor, ProcessorInput, ProcessingResult } from './processor';

/** Simulates the external system: the logic is irrelevant, the ~5 s of latency is real. */
@Injectable()
export class FakeExternalProcessor implements Processor {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  async process(event: ProcessorInput, signal: AbortSignal): Promise<ProcessingResult> {
    await sleep(this.config.processingDelayMs, undefined, { signal });
    if (Math.random() < this.config.fakeFailureRate) {
      throw new Error('fake external system failed (injected)');
    }
    return { processedBy: 'fake-external', eventType: event.type };
  }
}
