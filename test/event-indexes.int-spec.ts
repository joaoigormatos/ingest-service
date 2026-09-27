import { getModelToken } from '@nestjs/mongoose';
import { Test, TestingModule } from '@nestjs/testing';
import { Model } from 'mongoose';
import { ConfigModule } from '../src/config/config.module';
import { APP_CONFIG } from '../src/config/config';
import { DatabaseModule } from '../src/database/database.module';
import { EventModelModule } from '../src/events/event-model.module';
import { EventRecord } from '../src/events/event.schema';
import { testConfig } from './support/test-config';

describe('events collection indexes', () => {
  let moduleRef: TestingModule;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [ConfigModule, DatabaseModule, EventModelModule],
    })
      .overrideProvider(APP_CONFIG)
      .useValue(testConfig())
      .compile();
    await moduleRef.init();
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  it('are created on startup', async () => {
    const model = moduleRef.get<Model<EventRecord>>(getModelToken(EventRecord.name));
    const indexes = await model.collection.indexes();
    const byName = new Map(indexes.map((index) => [index.name, index]));

    expect(byName.get('dedup_key_unique')).toMatchObject({ key: { dedupKey: 1 }, unique: true });
    expect(byName.get('one_processing_per_patient')).toMatchObject({
      key: { patientId: 1 },
      unique: true,
      partialFilterExpression: { status: 'processing' },
    });
    expect(byName.get('head_selection')).toMatchObject({
      key: { status: 1, patientId: 1, ts: 1, _id: 1 },
    });
    expect(byName.get('expired_leases')).toMatchObject({ key: { status: 1, leaseUntil: 1 } });
    expect(byName.get('patient_sequence_unique')).toMatchObject({
      key: { patientId: 1, patientSeq: -1 },
      unique: true,
      partialFilterExpression: { patientSeq: { $exists: true } },
    });
  });
});
