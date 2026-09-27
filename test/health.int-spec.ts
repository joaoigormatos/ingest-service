import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { ApiModule } from '../src/app/api.module';
import { APP_CONFIG } from '../src/config/config';
import { testConfig } from './support/test-config';

describe('GET /health', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [ApiModule] })
      .overrideProvider(APP_CONFIG)
      .useValue(testConfig())
      .compile();
    app = await moduleRef.createNestApplication().init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('reports ok while connected to MongoDB', async () => {
    await request(app.getHttpServer()).get('/health').expect(200, { status: 'ok' });
  });
});
