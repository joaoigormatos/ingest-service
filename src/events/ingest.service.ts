import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, Clock } from '../common/clock';
import { APP_CONFIG, AppConfig } from '../config/config';
import { isDuplicateKeyError } from '../common/errors';
import { computeDedupKey } from './dedup-key';
import { CreateEventDto } from './event.dto';
import { EventStatus } from './event.schema';
import { EventsRepository, NewEvent } from './events.repository';

export interface IngestResult {
  readonly id: string;
  readonly status: EventStatus;
  /** True when this delivery matched an event that was already stored. */
  readonly duplicate: boolean;
}

@Injectable()
export class IngestService {
  constructor(
    private readonly events: EventsRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** Stores the event durably, or finds the copy stored by an earlier delivery. */
  async ingest(dto: CreateEventDto): Promise<IngestResult> {
    const event = this.toNewEvent(dto);
    try {
      const id = await this.events.insert(event);
      return { id, status: event.status, duplicate: false };
    } catch (error) {
      // The unique dedupKey index turns a racing or retried delivery into a collision, not a second document.
      if (!isDuplicateKeyError(error)) throw error;
      return this.findOriginal(event.dedupKey);
    }
  }

  private async findOriginal(dedupKey: string): Promise<IngestResult> {
    const original = await this.events.findByDedupKey(dedupKey);
    if (!original) throw new Error(`duplicate key reported but no event has dedupKey ${dedupKey}`);
    return { id: original._id.toHexString(), status: original.status, duplicate: true };
  }

  private toNewEvent(dto: CreateEventDto): NewEvent {
    const ts = new Date(dto.ts);
    const receivedAt = this.clock.now();
    return {
      patientId: dto.patientId,
      type: dto.type,
      data: dto.data,
      ts,
      dedupKey: computeDedupKey({ patientId: dto.patientId, type: dto.type, ts, data: dto.data }),
      status: 'pending',
      receivedAt,
      availableAt: new Date(receivedAt.getTime() + this.config.graceMs),
      attempts: 0,
    };
  }
}
