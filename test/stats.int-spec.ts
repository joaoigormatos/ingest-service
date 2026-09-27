import { INestApplication } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { Model } from 'mongoose';
import request from 'supertest';
import { ApiModule } from '../src/app/api.module';
import { APP_CONFIG } from '../src/config/config';
import { EventRecord, EventStatus } from '../src/events/event.schema';
import { insertPending } from './support/events';
import { testConfig } from './support/test-config';

describe('GET /stats', () => {
  let app: INestApplication;
  let events: Model<EventRecord>;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [ApiModule] })
      .overrideProvider(APP_CONFIG)
      .useValue(testConfig())
      .compile();
    app = await moduleRef.createNestApplication().init();
    events = app.get(getModelToken(EventRecord.name));
  });

  beforeEach(async () => {
    await events.deleteMany({});
  });

  afterAll(async () => {
    await app.close();
  });

  async function insertWithStatus(patientId: string, status: EventStatus, takeovers?: number) {
    const id = await insertPending(events, {
      patientId,
      ts: '2026-01-01T10:00:00Z',
      receivedAt: new Date(),
    });
    await events.updateOne({ _id: id }, { status, ...(takeovers ? { takeovers } : {}) });
  }

  it('reports zeros for an empty collection', async () => {
    const response = await request(app.getHttpServer()).get('/stats').expect(200);

    expect(response.body).toEqual({
      pending: 0,
      processing: 0,
      completed: 0,
      failed: 0,
      oldestPendingAgeMs: 0,
      leaseTakeovers: 0,
    });
  });

  it('counts events per status and sums lease takeovers', async () => {
    await insertWithStatus('p1', 'processing', 2);
    await insertWithStatus('p2', 'completed', 1);
    await insertWithStatus('p3', 'completed');
    await insertWithStatus('p4', 'failed');
    await insertPending(events, {
      patientId: 'p5',
      ts: '2026-01-01T10:00:00Z',
      receivedAt: new Date(),
    });

    const response = await request(app.getHttpServer()).get('/stats').expect(200);

    expect(response.body).toMatchObject({
      pending: 1,
      processing: 1,
      completed: 2,
      failed: 1,
      leaseTakeovers: 3,
    });
  });

  it('reports the age of the oldest pending event, the backpressure signal', async () => {
    await insertPending(events, {
      patientId: 'p1',
      ts: '2026-01-01T10:00:00Z',
      receivedAt: new Date(Date.now() - 5000),
    });
    await insertPending(events, {
      patientId: 'p2',
      ts: '2026-01-01T10:00:00Z',
      receivedAt: new Date(),
    });

    const response = await request(app.getHttpServer()).get('/stats').expect(200);

    expect(response.body.oldestPendingAgeMs).toBeGreaterThanOrEqual(5000);
    expect(response.body.oldestPendingAgeMs).toBeLessThan(10000);
  });
});
