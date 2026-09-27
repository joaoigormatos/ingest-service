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
}

export const APP_CONFIG = Symbol('APP_CONFIG');

type Env = Readonly<Record<string, string | undefined>>;

export function loadConfig(env: Env = process.env): AppConfig {
  return {
    port: readPositiveInt(env, 'PORT', 3000),
    mongoUri: env.MONGO_URI ?? 'mongodb://localhost:27017/ingest?replicaSet=rs0',
    mongoTimeoutMs: readPositiveInt(env, 'MONGO_TIMEOUT_MS', 5000),
  };
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
