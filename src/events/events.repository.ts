import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { EventDocument, EventRecord } from './event.schema';

export type NewEvent = Pick<
  EventRecord,
  | 'patientId'
  | 'type'
  | 'data'
  | 'ts'
  | 'dedupKey'
  | 'status'
  | 'receivedAt'
  | 'availableAt'
  | 'attempts'
>;

@Injectable()
export class EventsRepository {
  constructor(@InjectModel(EventRecord.name) private readonly model: Model<EventRecord>) {}

  /** Inserts the event and resolves once it is durable (majority + journal, see connection-options.ts). */
  async insert(event: NewEvent): Promise<string> {
    const created = await this.model.create(event);
    return created._id.toHexString();
  }

  findByDedupKey(dedupKey: string): Promise<EventDocument | null> {
    return this.model.findOne({ dedupKey }).lean<EventDocument>().exec();
  }

  findById(id: string): Promise<EventDocument | null> {
    return this.model.findById(id).lean<EventDocument>().exec();
  }
}
