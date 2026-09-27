import { Inject, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types, UpdateQuery } from 'mongoose';
import { CLOCK, Clock } from '../common/clock';
import { isDuplicateKeyError } from '../common/errors';
import { APP_CONFIG, AppConfig } from '../config/config';
import { EventDocument, EventRecord } from '../events/event.schema';
import { ProcessingResult } from './processor';

/** An event this worker holds the lease on. `leaseOwner` + `attempts` are its fencing token. */
export type ClaimedEvent = EventDocument & {
  readonly leaseOwner: string;
  readonly attempts: number;
};

const CLEAR_LEASE = { leaseOwner: 1, leaseUntil: 1 } as const;

/**
 * Every MongoDB operation of the claim protocol. Ordering and exactly-once outcomes rest on
 * three things only, all enforced by MongoDB itself:
 *  1. the partial unique index `one_processing_per_patient` (one event in flight per patient),
 *  2. claiming only a patient's head (lowest ts, then _id) and re-checking it after the claim,
 *  3. fenced writes: an outcome is stored only by the lease that is still current.
 */
@Injectable()
export class ClaimRepository {
  constructor(
    @InjectModel(EventRecord.name) private readonly model: Model<EventRecord>,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Takes over one event whose lease expired: its worker crashed, was killed or hung. The event stays
   * 'processing', so the patient's slot in the partial index is kept and nothing overtakes it.
   * attempts is incremented, which fences off the previous owner should it wake up.
   */
  takeOverExpired(workerId: string): Promise<ClaimedEvent | null> {
    return this.model
      .findOneAndUpdate(
        { status: 'processing', leaseUntil: { $lt: this.clock.now() } },
        { $set: { leaseOwner: workerId, leaseUntil: this.leaseDeadline() }, $inc: { attempts: 1 } },
        { sort: { leaseUntil: 1 }, returnDocument: 'after' },
      )
      .lean<ClaimedEvent>()
      .exec();
  }

  /**
   * Candidates to claim: the head event of each patient with nothing in flight, the patient
   * waiting longest first. Only a hint; claimHead re-validates atomically.
   */
  async findHeads(): Promise<Types.ObjectId[]> {
    const busyPatients = await this.model.distinct('patientId', { status: 'processing' });
    const heads = await this.model.aggregate<{ headId: Types.ObjectId }>([
      // Busy patients would be refused by the partial index anyway, but their events are the oldest
      // waiting: left in, they would fill the candidate list and starve slots that could do work.
      { $match: { status: 'pending', patientId: { $nin: busyPatients } } },
      { $sort: { patientId: 1, ts: 1, _id: 1 } },
      {
        $group: {
          _id: '$patientId',
          headId: { $first: '$_id' },
          headAvailableAt: { $first: '$availableAt' },
          waitingSince: { $min: '$receivedAt' },
        },
      },
      // Availability is checked only AFTER the head is chosen. Filtering pending events by availableAt
      // first would let the next event jump ahead of a head that is waiting out a retry backoff.
      { $match: { headAvailableAt: { $lte: this.clock.now() } } },
      { $sort: { waitingSince: 1 } },
      { $limit: this.config.headCandidates },
    ]);
    return heads.map((head) => head.headId);
  }

  /**
   * Claims a candidate head. Null means "try the next candidate": another worker got it first,
   * the patient already has an event in flight, or the candidate is no longer the head.
   */
  async claimHead(eventId: Types.ObjectId, workerId: string): Promise<ClaimedEvent | null> {
    const claimed = await this.markProcessing(eventId, workerId);
    if (!claimed) return null;
    // The candidate list can be stale (e.g. an earlier event was released for retry after it was built).
    // Now that this patient has an event in flight nothing else of theirs can be claimed, so the check is stable.
    if (await this.hasEarlierPending(claimed)) {
      await this.release(claimed);
      return null;
    }
    return claimed;
  }

  /** Stores the outcome. False if the lease was lost: the outcome must be discarded. */
  async complete(claim: ClaimedEvent, result: ProcessingResult): Promise<boolean> {
    const sequence = await this.nextInSequence(claim);
    return this.writeIfLeaseHeld(claim, {
      $set: { status: 'completed', result, completedAt: this.clock.now(), ...sequence },
      $unset: CLEAR_LEASE,
    });
  }

  /** Puts a failed attempt back in the queue, not claimable before `availableAt`. */
  releaseForRetry(claim: ClaimedEvent, error: string, availableAt: Date): Promise<boolean> {
    return this.writeIfLeaseHeld(claim, {
      $set: { status: 'pending', lastError: error, availableAt },
      $unset: CLEAR_LEASE,
    });
  }

  /** Gives up on the event. It is kept, never deleted, so nothing clinical is silently lost. */
  markFailed(claim: ClaimedEvent, error: string): Promise<boolean> {
    return this.writeIfLeaseHeld(claim, {
      $set: { status: 'failed', lastError: error },
      $unset: CLEAR_LEASE,
    });
  }

  /** Hands the event back unchanged; it was not a failed attempt. */
  release(claim: ClaimedEvent): Promise<boolean> {
    return this.writeIfLeaseHeld(claim, { $set: { status: 'pending' }, $unset: CLEAR_LEASE });
  }

  private async markProcessing(
    eventId: Types.ObjectId,
    workerId: string,
  ): Promise<ClaimedEvent | null> {
    try {
      return await this.model
        .findOneAndUpdate(
          // Matching on status makes the claim atomic: of several workers racing for it, one wins.
          { _id: eventId, status: 'pending' },
          {
            $set: { status: 'processing', leaseOwner: workerId, leaseUntil: this.leaseDeadline() },
            $inc: { attempts: 1 },
          },
          { returnDocument: 'after' },
        )
        .lean<ClaimedEvent>()
        .exec();
    } catch (error) {
      // one_processing_per_patient refused it: this patient already has an event in flight.
      if (isDuplicateKeyError(error)) return null;
      throw error;
    }
  }

  private async hasEarlierPending(event: ClaimedEvent): Promise<boolean> {
    const earlier = await this.model.exists({
      patientId: event.patientId,
      status: 'pending',
      $or: [{ ts: { $lt: event.ts } }, { ts: event.ts, _id: { $lt: event._id } }],
    });
    return earlier !== null;
  }

  /**
   * Where this event lands in the patient's applied history. Reading then writing is safe because the
   * patient has no other event in flight; the unique patient_sequence_unique index backs that up.
   */
  private async nextInSequence(
    claim: ClaimedEvent,
  ): Promise<{ patientSeq: number; outOfOrder: boolean }> {
    const { patientId } = claim;
    const [last, latest] = await Promise.all([
      this.model
        .findOne({ patientId, patientSeq: { $exists: true } })
        .sort({ patientSeq: -1 })
        .lean(),
      this.model.findOne({ patientId, status: 'completed' }).sort({ ts: -1 }).lean(),
    ]);
    return {
      patientSeq: (last?.patientSeq ?? 0) + 1,
      outOfOrder: latest !== null && claim.ts < latest.ts,
    };
  }

  private async writeIfLeaseHeld(
    claim: ClaimedEvent,
    update: UpdateQuery<EventRecord>,
  ): Promise<boolean> {
    const { matchedCount } = await this.model.updateOne(leaseFence(claim), update);
    return matchedCount === 1;
  }

  private leaseDeadline(): Date {
    return new Date(this.clock.now().getTime() + this.config.leaseMs);
  }
}

/**
 * Matches the event only while this exact lease is current. leaseOwner alone is not enough: all
 * slots of a process share one workerId, so a re-claim by the same process would look identical.
 * attempts grows on every claim and never decreases, so a superseded lease can never match again.
 */
function leaseFence(claim: ClaimedEvent) {
  return {
    _id: claim._id,
    status: 'processing',
    leaseOwner: claim.leaseOwner,
    attempts: claim.attempts,
  } as const;
}
