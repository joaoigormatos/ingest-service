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
