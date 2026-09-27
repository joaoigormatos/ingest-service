import { getModelToken } from '@nestjs/mongoose';
import { Test, TestingModule } from '@nestjs/testing';
import { Model } from 'mongoose';
import { setTimeout as sleep } from 'node:timers/promises';
import { WorkerModule } from '../src/app/worker.module';
import { APP_CONFIG, AppConfig } from '../src/config/config';
import { EventRecord } from '../src/events/event.schema';
import {
  PROCESSOR,
  Processor,
  ProcessorInput,
  ProcessingResult,
} from '../src/processing/processor';
import { eventually, insertPending } from './support/events';
import { testConfig } from './support/test-config';

/** Controllable stand-in for the slow external system. */
class StubProcessor implements Processor {
  readonly calls: ProcessorInput[] = [];

  constructor(private readonly behaviour: (event: ProcessorInput) => Promise<ProcessingResult>) {}

  process(event: ProcessorInput): Promise<ProcessingResult> {
    this.calls.push(event);
    return this.behaviour(event);
  }
}

async function startWorker(config: AppConfig, processor: Processor): Promise<TestingModule> {
  const moduleRef = await Test.createTestingModule({ imports: [WorkerModule] })
    .overrideProvider(APP_CONFIG)
    .useValue(config)
    .overrideProvider(PROCESSOR)
    .useValue(processor)
    .compile();
  return moduleRef.init();
}

const fastWorker = () => testConfig({ workerConcurrency: 4, pollIntervalMs: 20 });

describe('WorkerService', () => {
  let moduleRef: TestingModule;
  let events: Model<EventRecord>;

  afterEach(async () => {
    await moduleRef.close();
  });

  it('completes events with the result of the processor', async () => {
    const processor = new StubProcessor(async (event) => ({ echo: event.id }));
    moduleRef = await startWorker(fastWorker(), processor);
    events = moduleRef.get(getModelToken(EventRecord.name));

    const id = await insertPending(events, {
      patientId: 'p1',
      ts: '2026-01-01T10:00:00Z',
      receivedAt: new Date(),
    });

    await eventually(async () => {
      expect(await events.findById(id).lean()).toMatchObject({
        status: 'completed',
        result: { echo: id.toHexString() },
      });
    });
  });

  it('processes each patient in ts order while patients run in parallel', async () => {
    const processor = new StubProcessor(async () => {
      await sleep(20);
      return {};
    });
    moduleRef = await startWorker(fastWorker(), processor);
    events = moduleRef.get(getModelToken(EventRecord.name));
    // Nothing is claimable until every event is inserted, so arrival order cannot interfere.
    const availableAt = new Date(Date.now() + 500);
    const times = ['10:03', '10:01', '10:04', '10:02'];
    for (const patientId of ['p1', 'p2']) {
      for (const t of times) {
        await insertPending(events, {
          patientId,
          ts: `2026-01-01T${t}:00Z`,
          receivedAt: new Date(),
          availableAt,
        });
      }
    }

    await eventually(async () => {
      expect(await events.countDocuments({ status: 'completed' })).toBe(8);
    });
    for (const patientId of ['p1', 'p2']) {
      const order = processor.calls
        .filter((c) => c.patientId === patientId)
        .map((c) => c.ts.toISOString());
      expect(order).toEqual([...order].sort());
      expect(order).toHaveLength(4);
    }
  });
});
