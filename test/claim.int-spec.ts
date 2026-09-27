import { Types } from 'mongoose';
import { ClaimRepository } from '../src/processing/claim.repository';
import { EventStore, insertPending, openEventStore } from './support/events';
import { FakeClock } from './support/fake-clock';
import { testConfig } from './support/test-config';

describe('ClaimRepository', () => {
  const config = testConfig({ leaseMs: 30000, headCandidates: 20 });
  let store: EventStore;
  let clock: FakeClock;
  let claims: ClaimRepository;

  beforeAll(async () => {
    store = await openEventStore(config);
  });

  beforeEach(async () => {
    await store.model.deleteMany({});
    clock = new FakeClock();
    claims = new ClaimRepository(store.model, config, clock);
  });

  afterAll(async () => {
    await store.connection.close();
  });

  const pending = (patientId: string, ts: string) =>
    insertPending(store.model, { patientId, ts, receivedAt: clock.now() });

  async function claimHeadOf(workerId: string) {
    const [headId] = await claims.findHeads();
    if (!headId) throw new Error('no claimable head');
    const claim = await claims.claimHead(headId, workerId);
    if (!claim) throw new Error(`could not claim ${headId.toHexString()}`);
    return claim;
  }

  describe('findHeads', () => {
    it('returns only the earliest pending event of each patient', async () => {
      await pending('p1', '2026-01-01T10:02:00Z');
      const first = await pending('p1', '2026-01-01T10:01:00Z');

      expect(await claims.findHeads()).toEqual([first]);
    });

    it('breaks ts ties by insertion order (_id)', async () => {
      const first = await pending('p1', '2026-01-01T10:00:00Z');
      await pending('p1', '2026-01-01T10:00:00Z');

      expect(await claims.findHeads()).toEqual([first]);
    });

    it('lists the patient waiting longest first', async () => {
      const older = await pending('p2', '2026-01-01T10:00:00Z');
      clock.advance(1000);
      const newer = await pending('p1', '2026-01-01T09:00:00Z');

      expect(await claims.findHeads()).toEqual([older, newer]);
    });

    it('skips patients that already have an event in flight', async () => {
      await pending('p1', '2026-01-01T10:00:00Z');
      await pending('p1', '2026-01-01T10:01:00Z');
      await claimHeadOf('w1');

      expect(await claims.findHeads()).toEqual([]);
    });
  });

  describe('claimHead', () => {
    it('marks the event processing under a lease for the claiming worker', async () => {
      const id = await pending('p1', '2026-01-01T10:00:00Z');

      const claim = await claims.claimHead(id, 'w1');

      expect(claim).toMatchObject({
        _id: id,
        status: 'processing',
        leaseOwner: 'w1',
        attempts: 1,
        leaseUntil: new Date(clock.now().getTime() + config.leaseMs),
      });
    });

    it('lets exactly one of many concurrent claims for the same event win', async () => {
      const id = await pending('p1', '2026-01-01T10:00:00Z');

      const results = await Promise.all(
        Array.from({ length: 10 }, (_, i) => claims.claimHead(id, `w${i}`)),
      );

      expect(results.filter((claim) => claim !== null)).toHaveLength(1);
      expect(await store.model.findById(id).lean()).toMatchObject({ attempts: 1 });
    });

    it('refuses a second event of a patient while one is processing (partial unique index)', async () => {
      await pending('p1', '2026-01-01T10:00:00Z');
      const second = await pending('p1', '2026-01-01T10:01:00Z');
      await claimHeadOf('w1');

      expect(await claims.claimHead(second, 'w2')).toBeNull();
      expect(await store.model.findById(second).lean()).toMatchObject({ status: 'pending' });
    });

    it('never leaves two events of a patient in flight under concurrent claims', async () => {
      const ids = await Promise.all(
        ['10:00', '10:01', '10:02', '10:03'].map((t) => pending('p1', `2026-01-01T${t}:00Z`)),
      );

      await Promise.all(ids.map((id, i) => claims.claimHead(id, `w${i}`)));

      expect(await store.model.countDocuments({ status: 'processing' })).toBeLessThanOrEqual(1);
    });

    it('refuses a stale candidate while an earlier event of the patient is pending', async () => {
      await pending('p1', '2026-01-01T10:00:00Z');
      const later = await pending('p1', '2026-01-01T10:01:00Z');

      expect(await claims.claimHead(later, 'w1')).toBeNull();
      const doc = await store.model.findById(later).lean();
      expect(doc).toMatchObject({ status: 'pending' });
      expect(doc?.leaseOwner).toBeUndefined();
    });

    it('returns null for an event that is no longer pending', async () => {
      const id = await pending('p1', '2026-01-01T10:00:00Z');
      await claims.claimHead(id, 'w1');

      expect(await claims.claimHead(id, 'w2')).toBeNull();
    });
  });

  it('processes a patient in ts order even when events arrived out of order', async () => {
    for (const t of ['10:03', '10:01', '10:02']) await pending('p1', `2026-01-01T${t}:00Z`);

    const order: string[] = [];
    for (let i = 0; i < 3; i++) {
      const claim = await claimHeadOf('w1');
      order.push(claim.ts.toISOString());
      await claims.complete(claim, { ok: true });
    }

    expect(order).toEqual([
      '2026-01-01T10:01:00.000Z',
      '2026-01-01T10:02:00.000Z',
      '2026-01-01T10:03:00.000Z',
    ]);
  });

  describe('complete', () => {
    it('stores the result and releases the lease', async () => {
      await pending('p1', '2026-01-01T10:00:00Z');
      const claim = await claimHeadOf('w1');

      expect(await claims.complete(claim, { score: 7 })).toBe(true);

      const doc = await store.model.findById(claim._id).lean();
      expect(doc).toMatchObject({
        status: 'completed',
        result: { score: 7 },
        completedAt: clock.now(),
      });
      expect(doc?.leaseOwner).toBeUndefined();
      expect(doc?.leaseUntil).toBeUndefined();
    });

    it('rejects a zombie finalize from a claim that was superseded, leaving the document untouched', async () => {
      await pending('p1', '2026-01-01T10:00:00Z');
      const stale = await claimHeadOf('w1');
      await claims.releaseForRetry(stale, 'boom', clock.now());
      const current = await claimHeadOf('w1'); // same worker id, new lease: only attempts differ

      expect(await claims.complete(stale, { from: 'zombie' })).toBe(false);

      const doc = await store.model.findById(current._id).lean();
      expect(doc).toMatchObject({ status: 'processing', leaseOwner: 'w1', attempts: 2 });
      expect(doc?.result).toBeUndefined();
    });
  });

  describe('releaseForRetry', () => {
    it('returns the event to pending with the error and a new availability time', async () => {
      await pending('p1', '2026-01-01T10:00:00Z');
      const claim = await claimHeadOf('w1');
      const later = new Date(clock.now().getTime() + 5000);

      expect(await claims.releaseForRetry(claim, 'timeout', later)).toBe(true);

      const doc = await store.model.findById(claim._id).lean();
      expect(doc).toMatchObject({
        status: 'pending',
        lastError: 'timeout',
        availableAt: later,
        attempts: 1,
      });
      expect(doc?.leaseOwner).toBeUndefined();
    });
  });

  it('ignores ObjectIds that do not exist', async () => {
    expect(await claims.claimHead(new Types.ObjectId(), 'w1')).toBeNull();
  });
});
