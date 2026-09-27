import { INestApplication } from '@nestjs/common';
import { getConnectionToken, getModelToken } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { Connection, Model } from 'mongoose';
import request from 'supertest';
import { ApiModule } from '../src/app/api.module';
import { APP_CONFIG } from '../src/config/config';
import { EventRecord } from '../src/events/event.schema';
import { testConfig } from './support/test-config';

const event = {
  patientId: 'patient-1',
  type: 'vitals',
  data: { heartRate: 72, bp: { systolic: 120, diastolic: 80 } },
  ts: '2026-01-01T10:00:00Z',
};

const graceMs = 1500;

async function createApp(): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [ApiModule] })
    .overrideProvider(APP_CONFIG)
    .useValue(testConfig({ graceMs }))
    .compile();
  return moduleRef.createNestApplication().init();
}

describe('POST /events', () => {
  let app: INestApplication;
  let events: Model<EventRecord>;

  beforeAll(async () => {
    app = await createApp();
    events = app.get(getModelToken(EventRecord.name));
  });

  beforeEach(async () => {
    await events.deleteMany({});
  });

  afterAll(async () => {
    await app.close();
  });

  it('stores a new event as pending and answers 202', async () => {
    const response = await request(app.getHttpServer()).post('/events').send(event).expect(202);

    expect(response.body).toEqual({ id: expect.any(String), status: 'pending', duplicate: false });
    const stored = await events.findById(response.body.id).lean();
    expect(stored).toMatchObject({
      patientId: 'patient-1',
      type: 'vitals',
      data: event.data,
      ts: new Date(event.ts),
      status: 'pending',
      attempts: 0,
      dedupKey: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    // Held back for the grace window, so a slightly late earlier event can still be applied first.
    expect(stored!.availableAt.getTime() - stored!.receivedAt.getTime()).toBe(graceMs);
  });

  it('stores the same event exactly once when it is sent 20 times concurrently', async () => {
    const responses = await Promise.all(
      Array.from({ length: 20 }, () => request(app.getHttpServer()).post('/events').send(event)),
    );

    expect(responses.map((r) => r.status)).toEqual(Array(20).fill(202));
    expect(new Set(responses.map((r) => r.body.id)).size).toBe(1);
    expect(responses.filter((r) => r.body.duplicate === false)).toHaveLength(1);
    expect(await events.countDocuments()).toBe(1);
  });

  it('recognises a retry with reordered keys and an equivalent timestamp as a duplicate', async () => {
    const first = await request(app.getHttpServer()).post('/events').send(event);
    const retry = await request(app.getHttpServer())
      .post('/events')
      .send({
        ts: '2026-01-01T12:00:00.000+02:00',
        data: { bp: { diastolic: 80, systolic: 120 }, heartRate: 72 },
        type: 'vitals',
        patientId: 'patient-1',
      })
      .expect(202);

    expect(retry.body).toEqual({ id: first.body.id, status: 'pending', duplicate: true });
  });

  it('stores events that differ only in data as separate events', async () => {
    await request(app.getHttpServer()).post('/events').send(event);
    await request(app.getHttpServer())
      .post('/events')
      .send({ ...event, data: { heartRate: 90 } })
      .expect(202);

    expect(await events.countDocuments()).toBe(2);
  });

  it('ignores unknown top-level fields', async () => {
    await request(app.getHttpServer()).post('/events').send(event);
    const response = await request(app.getHttpServer())
      .post('/events')
      .send({ ...event, requestId: 'abc' });

    expect(response.body.duplicate).toBe(true);
  });

  it('rejects an invalid body with 400 and stores nothing', async () => {
    await request(app.getHttpServer())
      .post('/events')
      .send({ ...event, ts: 'not-a-date' })
      .expect(400);

    expect(await events.countDocuments()).toBe(0);
  });
});

describe('GET /events/:id', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns the stored document', async () => {
    const created = await request(app.getHttpServer()).post('/events').send(event);

    const response = await request(app.getHttpServer())
      .get(`/events/${created.body.id}`)
      .expect(200);

    expect(response.body).toMatchObject({
      _id: created.body.id,
      patientId: 'patient-1',
      status: 'pending',
    });
  });

  it('answers 404 for an unknown or malformed id', async () => {
    await request(app.getHttpServer()).get('/events/0123456789abcdef01234567').expect(404);
    await request(app.getHttpServer()).get('/events/not-an-id').expect(404);
  });
});

describe('POST /events while MongoDB is unavailable', () => {
  it('answers 503 so the sender retries', async () => {
    const app = await createApp();
    await app.get<Connection>(getConnectionToken()).close();

    await request(app.getHttpServer()).post('/events').send(event).expect(503);

    await app.close();
  });
});
