import { loadConfig } from '../src/config/config';

describe('loadConfig', () => {
  it('uses documented defaults when the environment is empty', () => {
    const config = loadConfig({});

    expect(config.port).toBe(3000);
    expect(config.mongoUri).toBe('mongodb://localhost:27017/ingest?replicaSet=rs0');
    expect(config.mongoTimeoutMs).toBe(5000);
  });

  it('reads values from the environment', () => {
    const config = loadConfig({ PORT: '8080', MONGO_URI: 'mongodb://db:27017/x' });

    expect(config.port).toBe(8080);
    expect(config.mongoUri).toBe('mongodb://db:27017/x');
  });

  it('rejects a value that is not a positive integer', () => {
    expect(() => loadConfig({ PORT: 'abc' })).toThrow('PORT');
    expect(() => loadConfig({ MONGO_TIMEOUT_MS: '-5' })).toThrow('MONGO_TIMEOUT_MS');
    expect(() => loadConfig({ MONGO_TIMEOUT_MS: '1.5' })).toThrow('MONGO_TIMEOUT_MS');
  });
});

describe('loadConfig worker settings', () => {
  it('uses documented defaults', () => {
    expect(loadConfig({})).toMatchObject({
      workerConcurrency: 40,
      leaseMs: 30000,
      externalTimeoutMs: 15000,
      processingDelayMs: 5000,
      pollIntervalMs: 1000,
      headCandidates: 20,
    });
  });

  it('requires the external call timeout to be shorter than the lease', () => {
    expect(() => loadConfig({ LEASE_MS: '10000', EXTERNAL_TIMEOUT_MS: '10000' })).toThrow(
      'EXTERNAL_TIMEOUT_MS',
    );
  });
});
