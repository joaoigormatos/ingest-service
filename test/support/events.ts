import { randomBytes } from 'node:crypto';
import mongoose, { Connection, Model, Types } from 'mongoose';
import { AppConfig } from '../../src/config/config';
import { mongoConnectionOptions } from '../../src/database/connection-options';
import { EventRecord, EventSchema } from '../../src/events/event.schema';

export interface EventStore {
  readonly model: Model<EventRecord>;
  readonly connection: Connection;
}

/** A real connection and events model (with its indexes) on the test replica set. */
export async function openEventStore(config: AppConfig): Promise<EventStore> {
  const connection = await mongoose
    .createConnection(config.mongoUri, mongoConnectionOptions(config))
    .asPromise();
  const model = connection.model(EventRecord.name, EventSchema);
  await model.createIndexes();
  return { model, connection };
}

export interface PendingEventInput {
  readonly patientId: string;
  readonly ts: string;
  readonly receivedAt: Date;
  readonly availableAt?: Date;
}

/** Inserts a pending event the way the API would, with a unique dedupKey. */
export async function insertPending(
  model: Model<EventRecord>,
  input: PendingEventInput,
): Promise<Types.ObjectId> {
  const created = await model.create({
    patientId: input.patientId,
    type: 'vitals',
    data: { value: input.ts },
    ts: new Date(input.ts),
    dedupKey: randomBytes(32).toString('hex'),
    status: 'pending',
    receivedAt: input.receivedAt,
    availableAt: input.availableAt ?? input.receivedAt,
    attempts: 0,
  });
  return created._id;
}

/** Polls until the assertion stops throwing, or rethrows its last error after the timeout. */
export async function eventually(assertion: () => Promise<void>, timeoutMs = 10000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await assertion();
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}
