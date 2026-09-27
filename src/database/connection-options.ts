import type { ConnectOptions } from 'mongoose';
import type { AppConfig } from '../config/config';

/** Connection options shared by the Nest apps, the tests and the demo scripts. */
export function mongoConnectionOptions(config: AppConfig): ConnectOptions {
  return {
    // A write is acknowledged only once it is journaled on a majority of the replica set,
    // so a 202 never refers to an event a failover or crash could still roll back.
    writeConcern: { w: 'majority', journal: true },
    // Fail fast instead of queueing operations in memory while disconnected: the API should
    // answer 503 (sender retries) rather than hold requests that may never be stored.
    bufferCommands: false,
    serverSelectionTimeoutMS: config.mongoTimeoutMs,
    // Indexes carry correctness guarantees, so they are created explicitly and awaited at startup.
    autoIndex: false,
  };
}
