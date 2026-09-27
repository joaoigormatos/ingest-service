import { MongoMemoryReplSet } from 'mongodb-memory-server';

// One single-node replica set for the whole test run: majority/journaled writes and
// partial unique indexes behave exactly as in production. Each test file uses its own database.
export default async function globalSetup(): Promise<void> {
  const replSet = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: 'wiredTiger' },
  });
  (globalThis as { __MONGO_REPLSET__?: MongoMemoryReplSet }).__MONGO_REPLSET__ = replSet;
  process.env.TEST_MONGO_URI = replSet.getUri();
}
