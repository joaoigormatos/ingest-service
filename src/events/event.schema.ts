import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Types } from 'mongoose';

export const EVENT_STATUSES = ['pending', 'processing', 'completed', 'failed'] as const;
export type EventStatus = (typeof EVENT_STATUSES)[number];

/**
 * One document per unique event. The `events` collection is at the same time the queue
 * (status 'pending'), the lease store (leaseOwner/leaseUntil) and the result store.
 */
// minimize:false keeps `data: {}` instead of silently dropping the empty object.
@Schema({ collection: 'events', minimize: false, versionKey: false })
export class EventRecord {
  @Prop({ required: true })
  readonly patientId!: string;

  @Prop({ required: true })
  readonly type!: string;

  @Prop({ type: Object, required: true })
  readonly data!: Record<string, unknown>;

  /** Event time, as reported by the sender. Defines the per-patient order. */
  @Prop({ required: true })
  readonly ts!: Date;

  /** sha256 of the canonical event content; see dedup-key.ts. */
  @Prop({ required: true })
  readonly dedupKey!: string;

  @Prop({ required: true, enum: EVENT_STATUSES })
  readonly status!: EventStatus;

  @Prop({ required: true })
  readonly receivedAt!: Date;

  /** Not claimable before this instant (retry backoff). */
  @Prop({ required: true })
  readonly availableAt!: Date;

  /** Number of times the event was claimed. Only ever increases; part of the fencing token. */
  @Prop({ required: true, default: 0 })
  readonly attempts!: number;

  @Prop()
  readonly leaseOwner?: string;

  @Prop()
  readonly leaseUntil?: Date;

  @Prop()
  readonly lastError?: string;

  @Prop({ type: Object })
  readonly result?: Record<string, unknown>;

  @Prop()
  readonly completedAt?: Date;
}

/** A plain (lean) events document as read from MongoDB. */
export type EventDocument = Readonly<EventRecord & { _id: Types.ObjectId }>;

export const EventSchema = SchemaFactory.createForClass(EventRecord);

// Identical content = same event: a retry or duplicate delivery collides here instead of creating a second document.
EventSchema.index({ dedupKey: 1 }, { unique: true, name: 'dedup_key_unique' });

// At most one event per patient may be 'processing'. MongoDB enforces this, not the workers:
// a second concurrent claim for the same patient fails with a duplicate-key error (11000).
EventSchema.index(
  { patientId: 1 },
  {
    unique: true,
    partialFilterExpression: { status: 'processing' },
    name: 'one_processing_per_patient',
  },
);

// Finding each patient's head: pending events of a patient in (ts, _id) order.
EventSchema.index({ status: 1, patientId: 1, ts: 1, _id: 1 }, { name: 'head_selection' });

// Finding processing events whose lease expired (their worker died or hung).
EventSchema.index({ status: 1, leaseUntil: 1 }, { name: 'expired_leases' });
