import { randomBytes } from 'node:crypto';
import { AppConfig, loadConfig } from '../../src/config/config';

/** Replica-set URI of the shared test server, pointed at a database unique to the caller. */
export function uniqueTestMongoUri(): string {
  const base = process.env.TEST_MONGO_URI;
  if (!base) throw new Error('TEST_MONGO_URI is not set; is the Jest globalSetup configured?');
  const url = new URL(base);
  url.pathname = `/test_${randomBytes(4).toString('hex')}`;
  return url.toString();
}

export function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return { ...loadConfig({}), mongoUri: uniqueTestMongoUri(), ...overrides };
}
