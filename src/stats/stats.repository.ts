import { Inject, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { CLOCK, Clock } from '../common/clock';
import { EventRecord, EventStatus } from '../events/event.schema';

export type Stats = Readonly<Record<EventStatus, number>> & {
  /** Age of the oldest event still waiting. Growing = workers are not keeping up (backpressure). */
  readonly oldestPendingAgeMs: number;
  readonly leaseTakeovers: number;
};

@Injectable()
export class StatsRepository {
  constructor(
    @InjectModel(EventRecord.name) private readonly model: Model<EventRecord>,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async snapshot(): Promise<Stats> {
    const [counts, oldestPendingAgeMs, leaseTakeovers] = await Promise.all([
      this.countByStatus(),
      this.oldestPendingAgeMs(),
      this.totalTakeovers(),
    ]);
    return { ...counts, oldestPendingAgeMs, leaseTakeovers };
  }

  /** One indexed count per status (status is the prefix of head_selection). */
  private async countByStatus(): Promise<Record<EventStatus, number>> {
    const count = (status: EventStatus) => this.model.countDocuments({ status }).exec();
    const [pending, processing, completed, failed] = await Promise.all([
      count('pending'),
      count('processing'),
      count('completed'),
      count('failed'),
    ]);
    return { pending, processing, completed, failed };
  }

  private async oldestPendingAgeMs(): Promise<number> {
    const oldest = await this.model
      .findOne({ status: 'pending' })
      .sort({ receivedAt: 1 })
      .select('receivedAt')
      .lean();
    return oldest ? Math.max(0, this.clock.now().getTime() - oldest.receivedAt.getTime()) : 0;
  }

  /** Scans the collection: fine for a diagnostics endpoint, a metrics counter at production scale. */
  private async totalTakeovers(): Promise<number> {
    const [row] = await this.model.aggregate<{ total: number }>([
      { $match: { takeovers: { $gt: 0 } } },
      { $group: { _id: null, total: { $sum: '$takeovers' } } },
    ]);
    return row?.total ?? 0;
  }
}
