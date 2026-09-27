import {
  BeforeApplicationShutdown,
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { CLOCK, Clock } from '../common/clock';
import { describeError } from '../common/errors';
import { APP_CONFIG, AppConfig } from '../config/config';
import { backoffMs } from './backoff';
import { ClaimRepository, ClaimedEvent } from './claim.repository';
import { PROCESSOR, Processor, ProcessorInput, ProcessingResult } from './processor';

type Outcome =
  | { readonly ok: true; readonly result: ProcessingResult }
  | { readonly ok: false; readonly error: string };

/**
 * Runs WORKER_CONCURRENCY independent slots. Each slot loops: claim the next head event,
 * process it, store the outcome under its lease. All coordination happens in MongoDB.
 */
@Injectable()
export class WorkerService implements OnApplicationBootstrap, BeforeApplicationShutdown {
  /** Unique per process; it appears in every lease this process takes. */
  readonly workerId = `${hostname()}-${process.pid}-${randomBytes(3).toString('hex')}`;
  private readonly logger = new Logger(WorkerService.name);
  private running = false;
  private slots: Promise<void>[] = [];
  /** Aborted when the shutdown grace period runs out, interrupting the external calls still running. */
  private readonly shutdown = new AbortController();

  constructor(
    private readonly claims: ClaimRepository,
    @Inject(PROCESSOR) private readonly processor: Processor,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  onApplicationBootstrap(): void {
    this.running = true;
    this.slots = Array.from({ length: this.config.workerConcurrency }, () => this.runSlot());
    this.logger.log(`worker=${this.workerId} started ${this.slots.length} slots`);
  }

  /**
   * Graceful shutdown (runs before the MongoDB connection closes): stop claiming, give in-flight events
   * SHUTDOWN_GRACE_MS to finish, then interrupt the rest and release their leases. This is only an
   * optimization: after a SIGKILL the leases expire and other workers take the events over anyway.
   */
  async beforeApplicationShutdown(): Promise<void> {
    this.running = false;
    const allDone = Promise.all(this.slots).then(() => true);
    const graceOver = sleep(this.config.shutdownGraceMs, false, { ref: false });
    if (!(await Promise.race([allDone, graceOver]))) {
      this.logger.warn(`worker=${this.workerId} grace period over; releasing in-flight events`);
      this.shutdown.abort();
      await allDone;
    }
  }

  private async runSlot(): Promise<void> {
    while (this.running) {
      try {
        const claim = await this.claimNext();
        if (claim) await this.handle(claim);
        else await this.idle();
      } catch (error) {
        // Typically MongoDB is unreachable. The slot survives; a lease it held expires and is taken over.
        this.logger.error(`worker=${this.workerId} slot error: ${describeError(error)}`);
        await this.idle();
      }
    }
  }

  /** Expired leases first: an abandoned event blocks its whole patient until someone takes it over. */
  private async claimNext(): Promise<ClaimedEvent | null> {
    return (await this.claims.takeOverExpired(this.workerId)) ?? (await this.claimNextHead());
  }

  private async claimNextHead(): Promise<ClaimedEvent | null> {
    for (const headId of await this.claims.findHeads()) {
      const claim = await this.claims.claimHead(headId, this.workerId);
      if (claim) return claim;
    }
    return null;
  }

  private async handle(claim: ClaimedEvent): Promise<void> {
    try {
      const stored = await this.processAndStore(claim);
      if (!stored) {
        this.logger.warn(
          `${this.tag(claim)} lease lost; outcome discarded (another worker owns it)`,
        );
      }
    } catch (error) {
      // The outcome could not be written; the lease will expire and the event will be taken over.
      this.logger.error(`${this.tag(claim)} outcome not stored: ${describeError(error)}`);
    }
  }

  private async processAndStore(claim: ClaimedEvent): Promise<boolean> {
    if (claim.attempts > this.config.maxAttempts) {
      // Only reachable by takeover: every worker that tried this event died or hung (a poison pill).
      return this.claims.markFailed(
        claim,
        `lease expired on all ${this.config.maxAttempts} attempts`,
      );
    }
    const started = performance.now();
    const outcome = await this.callProcessor(claim);
    if (!outcome.ok && this.shutdown.signal.aborted) {
      // Interrupted by our own shutdown, not a failure of the event: hand it back without counting it.
      return this.claims.release(claim);
    }
    return outcome.ok
      ? this.onSuccess(claim, outcome.result, performance.now() - started)
      : this.onFailure(claim, outcome.error);
  }

  private async onSuccess(
    claim: ClaimedEvent,
    result: ProcessingResult,
    elapsedMs: number,
  ): Promise<boolean> {
    const stored = await this.claims.complete(claim, result);
    if (stored) {
      this.logger.log(
        `${this.tag(claim)} completed patient=${claim.patientId} attempt=${claim.attempts} in ${Math.round(elapsedMs)} ms`,
      );
    }
    return stored;
  }

  private async callProcessor(claim: ClaimedEvent): Promise<Outcome> {
    try {
      const timeout = AbortSignal.timeout(this.config.externalTimeoutMs);
      const signal = AbortSignal.any([timeout, this.shutdown.signal]);
      return { ok: true, result: await this.processor.process(toProcessorInput(claim), signal) };
    } catch (error) {
      return { ok: false, error: describeError(error) };
    }
  }

  private onFailure(claim: ClaimedEvent, error: string): Promise<boolean> {
    this.logger.warn(`${this.tag(claim)} attempt ${claim.attempts} failed: ${error}`);
    if (claim.attempts >= this.config.maxAttempts) {
      this.logger.error(`${this.tag(claim)} failed permanently after ${claim.attempts} attempts`);
      return this.claims.markFailed(claim, error);
    }
    return this.claims.releaseForRetry(claim, error, this.retryAt(claim.attempts));
  }

  private retryAt(attempts: number): Date {
    const policy = { baseMs: this.config.retryBaseMs, maxMs: this.config.retryMaxMs };
    return new Date(this.clock.now().getTime() + backoffMs(attempts, policy));
  }

  /** Jittered so idle slots across processes do not poll in lockstep. */
  private idle(): Promise<void> {
    return sleep(this.config.pollIntervalMs * (0.5 + Math.random()));
  }

  private tag(claim: ClaimedEvent): string {
    return `event=${claim._id.toHexString()} worker=${this.workerId}`;
  }
}

function toProcessorInput(claim: ClaimedEvent): ProcessorInput {
  return {
    id: claim._id.toHexString(),
    patientId: claim.patientId,
    type: claim.type,
    ts: claim.ts,
    data: claim.data,
  };
}
