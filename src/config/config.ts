/**
 * Typed runtime configuration. Every timing and limit in the service comes from here,
 * each with a documented default, so nothing is a magic number at the call site.
 */
export interface AppConfig {
  /** HTTP port of the API process. PORT, default 3000. */
  readonly port: number;
  /** MongoDB connection string; must point at a replica set. MONGO_URI. */
  readonly mongoUri: string;
  /** How long a DB operation waits for a reachable primary before failing. MONGO_TIMEOUT_MS, default 5000. */
  readonly mongoTimeoutMs: number;
  /** Events processed at the same time by one worker process. WORKER_CONCURRENCY, default 40. */
  readonly workerConcurrency: number;
  /** How long a claim is valid before another worker may take it over. LEASE_MS, default 30000. */
  readonly leaseMs: number;
  /** Hard timeout of one external call; must be below LEASE_MS. EXTERNAL_TIMEOUT_MS, default 15000. */
  readonly externalTimeoutMs: number;
  /** Simulated duration of the external call. PROCESSING_DELAY_MS, default 5000. */
  readonly processingDelayMs: number;
  /** Idle wait between polls when nothing is claimable (jittered). POLL_INTERVAL_MS, default 1000. */
  readonly pollIntervalMs: number;
  /** Head candidates fetched per poll. HEAD_CANDIDATES, default 20. */
  readonly headCandidates: number;
  /** Attempts before an event is marked failed. MAX_ATTEMPTS, default 5. */
  readonly maxAttempts: number;
  /** First retry delay; doubles per attempt. RETRY_BASE_MS, default 1000. */
  readonly retryBaseMs: number;
  /** Upper bound of the retry delay. RETRY_MAX_MS, default 30000. */
  readonly retryMaxMs: number;
  /** Share of fake external calls that fail, 0..1, to exercise retries. FAKE_FAILURE_RATE, default 0. */
  readonly fakeFailureRate: number;
}

export const APP_CONFIG = Symbol('APP_CONFIG');

type Env = Readonly<Record<string, string | undefined>>;

export function loadConfig(env: Env = process.env): AppConfig {
  const config: AppConfig = {
    port: readPositiveInt(env, 'PORT', 3000),
    mongoUri: env.MONGO_URI ?? 'mongodb://localhost:27017/ingest?replicaSet=rs0',
    mongoTimeoutMs: readPositiveInt(env, 'MONGO_TIMEOUT_MS', 5000),
    workerConcurrency: readPositiveInt(env, 'WORKER_CONCURRENCY', 40),
    leaseMs: readPositiveInt(env, 'LEASE_MS', 30000),
    externalTimeoutMs: readPositiveInt(env, 'EXTERNAL_TIMEOUT_MS', 15000),
    processingDelayMs: readPositiveInt(env, 'PROCESSING_DELAY_MS', 5000),
    pollIntervalMs: readPositiveInt(env, 'POLL_INTERVAL_MS', 1000),
    headCandidates: readPositiveInt(env, 'HEAD_CANDIDATES', 20),
    maxAttempts: readPositiveInt(env, 'MAX_ATTEMPTS', 5),
    retryBaseMs: readPositiveInt(env, 'RETRY_BASE_MS', 1000),
    retryMaxMs: readPositiveInt(env, 'RETRY_MAX_MS', 30000),
    fakeFailureRate: readRate(env, 'FAKE_FAILURE_RATE', 0),
  };
  // A call that outlives its lease would race the worker that takes the event over.
  if (config.externalTimeoutMs >= config.leaseMs) {
    throw new Error('Config EXTERNAL_TIMEOUT_MS must be lower than LEASE_MS');
  }
  return config;
}

function readPositiveInt(env: Env, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Config ${name} must be a positive integer, got "${raw}"`);
  }
  return value;
}

function readRate(env: Env, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`Config ${name} must be a number between 0 and 1, got "${raw}"`);
  }
  return value;
}
