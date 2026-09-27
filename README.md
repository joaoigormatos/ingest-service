# Ingest Service

An HTTP ingest service for clinical events, built with NestJS and MongoDB. Third-party senders `POST /events`
and get an answer at once. Workers then process each event (a simulated external call of about 5 s) and
store the outcome. Processing has these guarantees:

- **Never lost.** An event is acknowledged only after it is durably written. Crashes at any point are recovered.
- **Never counted twice.** Retries and duplicate deliveries collapse into one stored event, and each event
  gets exactly one stored outcome.
- **Applied in order per patient.** Events for one patient are processed one at a time, in event-time order.

## Run it

Requirements: Docker (Compose v2) and Node 20.11+.

```bash
docker compose up --build -d      # MongoDB (replica set) + API on :3000 + 3 workers
npm install && npm run demo       # 5 min of load at 1000 events/min, then verifies the result
```

Other commands:

```bash
npm test                          # unit + integration tests (starts its own in-memory MongoDB replica set)
npm run chaos                     # in a second terminal while the demo runs: SIGKILLs workers/API every 5-15 s
npm run load -- --patients 300 --rate 1000 --minutes 5   # load only; npm run verify checks it afterwards
```

```bash
curl -i -X POST localhost:3000/events -H 'content-type: application/json' \
  -d '{"patientId":"p-1","type":"vitals","data":{"heartRate":72},"ts":"2026-01-01T10:00:00Z"}'
# HTTP/1.1 202 Accepted  {"id":"...","status":"pending","duplicate":false}
curl localhost:3000/events/<id>   # the stored document: status, attempts, result, patientSeq...
curl localhost:3000/stats         # counts per status, oldest pending age, lease takeovers
```

## How to see it hold up

`npm run demo` runs `scripts/load.ts` and then `scripts/verify.ts`.

The load generator behaves like the senders in the brief. It sends 1000 events/min for 300 patients,
with event times that increase per patient but are shuffled within windows of 10. About 10% of events
are sent twice, half of those concurrently. About 2% of first requests are abandoned mid-flight and
then retried. Timeouts, 5xx responses and refused connections are retried with backoff. Every unique
event goes into `manifest.json`.

The verifier waits until nothing is pending or processing. It then checks MongoDB directly against
the manifest:

1. every acknowledged event is stored exactly once;
2. nothing else is stored;
3. every event ended `completed` or `failed`;
4. for each patient, `patientSeq` has no gaps (continuing from earlier runs on the same database),
   and `ts` never goes backwards along it unless the event is flagged `outOfOrder`.

### Result: 5 minutes at 1000 events/min, 300 patients, 3 workers

Actual verifier output from a fresh `docker compose up` on a laptop. The compose file sets
`FAKE_FAILURE_RATE=0.05`, so about 5% of external calls fail and are retried.

```
PASS  every acknowledged event is stored exactly once
PASS  no events other than the ones sent
PASS  every event is completed or failed
PASS  per patient: patientSeq contiguous, ts in order except flagged late events

  events sent (unique)        5000   (5583 HTTP requests)
  stored                      5000
  completed / failed          5000 / 0
  throughput                  943 events/min
  ingest latency p50 / p99    7 ms / 23 ms
  received->completed p50/p99 7047 ms / 19791 ms
  duplicates absorbed         582
  abandoned requests          105
  sender retries              0   (undelivered: 0)
  events retried by workers   257
  lease takeovers             0
  applied out of order        0
```

How to read it:

- Throughput is measured from the first event received to the last event completed, so it includes the
  final drain. Load was offered at 1000/min.
- `received->completed` p50 is about 7 s: the 2 s grace window plus the 5 s external call. The p99 comes
  from events whose attempts failed and waited out a backoff.
- `applied out of order` is 0 because the shuffling (windows of 10 events, about 0.6 s) always fell
  inside the 2 s grace window.

### Result under chaos: the same load while `npm run chaos` runs

This run had 25 SIGKILLs in 5 minutes: 19 on workers and 6 on the API.

```
PASS  every acknowledged event is stored exactly once
PASS  no events other than the ones sent
PASS  every event is completed or failed
PASS  per patient: patientSeq contiguous, ts in order except flagged late events

  events sent (unique)        5000   (5801 HTTP requests)
  stored                      5000
  completed / failed          4999 / 1
  throughput                  801 events/min
  ingest latency p50 / p99    7 ms / 25 ms
  received->completed p50/p99 9715 ms / 110848 ms
  duplicates absorbed         612
  abandoned requests          92
  sender retries              185   (undelivered: 0)
  events retried by workers   764
  lease takeovers             638
  applied out of order        0
```

How to read it:

- **Nothing was lost or duplicated.** Each kill left about 40 events mid-processing. Their leases expired,
  and other workers took them over (638 takeovers). The fence discarded any late write from a killed
  worker.
- **While the API was down, senders saw refused connections** and retried (185 retries), and every event
  was eventually acknowledged. Latency grows because a patient waits out the 30 s lease of an event whose
  worker died.
- **The one `failed` event** has `lastError: "lease expired on all 5 attempts"`. It was claimed 6 times,
  and 3 of those claims were takeovers after the worker processing it was killed. When the claim count
  passed `MAX_ATTEMPTS`, the poison-pill guard failed it instead of trying again. The event is kept,
  visible and replayable, and its patient continued.

## Architecture

```
sender --POST /events--> API (stateless) --insert {status:'pending'}--> MongoDB: events (one collection)
                           |  202 after a majority,                       ^            |
                           |  journaled write                   fenced    |            | claim a patient's
                           v                                    finalize  |            v head event
                        503 if not stored                           workers (stateless, N slots each)
                        (sender retries)                                  |
                                                                          +--~5 s--> external system (fake)
```

- **API** (`src/main.api.ts`): validates the event, inserts it with `w:'majority', j:true`, and answers `202`.
  It does no processing.
- **Workers** (`src/main.worker.ts`): each process runs `WORKER_CONCURRENCY` (40) slots. In a loop, each
  slot takes over an expired lease or claims a patient's head event, calls the external system and
  stores the outcome under its lease. Three workers × 40 slots / 5 s gives 1440 events/min of capacity.
- **MongoDB**: a single-node replica set locally. The replica set is needed for majority writes.

**One collection is the queue, the lease store and the result store.** A single insert both stores the
event and enqueues it, so there is no dual write that could leave one side behind. The status transitions
(`pending → processing → completed | failed`) and the leases are atomic single-document updates. The
invariants that matter live in MongoDB as unique indexes, so no worker has to be trusted to enforce them.

Document shape (`src/events/event.schema.ts`):
`patientId, type, data, ts, dedupKey, status, receivedAt, availableAt, attempts, takeovers, leaseOwner,
leaseUntil, lastError, result, completedAt, patientSeq, outOfOrder`.

## Decisions

Each subsection follows the same pattern: condition → decision → trade-off accepted.

### Durability and the immediate answer

_Senders need an immediate answer, and clinical data must never be lost._
→ The API answers `202` only after the insert is acknowledged by a majority of the replica set and journaled
(`src/database/connection-options.ts`). If the write fails or its outcome is unknown, the API answers `503`
so the sender retries. `bufferCommands` is off, so while MongoDB is unreachable the API fails fast
instead of holding requests in memory.
→ **Trade-off:** delivery is at-least-once. A write can succeed while its acknowledgement is lost, and the
sender then retries. Duplicates are therefore unavoidable and must be absorbed, which the next decision does.

### Dedup without an event ID

_Senders retry and duplicate, and there is no event ID in the contract._
→ `dedupKey = sha256(canonical JSON of {patientId, type, ts, data})` (`src/events/dedup-key.ts`). The JSON
has its keys sorted at every level, and `ts` is normalised to one ISO spelling, so `Z`, `+00:00` and
`.000` all give the same key. Arrays keep their order because order carries meaning. A unique index
on `dedupKey` makes a duplicate insert fail with E11000. The API catches that error and answers the
same `202` with the original `id` and `duplicate: true`. Unknown top-level fields are stripped before
hashing, so a sender's `requestId` cannot split one event into two.
→ **Trade-offs:**

- Two genuinely distinct events with identical content collapse into one. I think that is correct:
  same patient, same type, same instant and same data is the same observation.
- A sender that changes the payload between retries (for example, adds a field) is not detected.
  This is a documented assumption.
- The dedup window equals the retention window: an event is recognised as a duplicate for as long
  as its document exists.

### Ordering per patient

_The result depends on the order in which a patient's events are applied._
Ordering is enforced by three mechanisms, all in `src/processing/claim.repository.ts`:

1. **One event in flight per patient, enforced by MongoDB.** A partial unique index on `{patientId}` covers
   only `status: 'processing'` documents. A second concurrent claim for the same patient fails with E11000.
   No locks and no coordinator are needed.
2. **Only the head is claimed.** The head is the patient's pending event with the lowest `ts`, then the
   lowest `_id`. Heads are found with an aggregation that sorts by `{patientId, ts, _id}` and groups by
   patient. Availability (`availableAt <= now`) is checked _after_ the head is picked. Filtering first would
   let the next event jump ahead of a head that is waiting out a retry backoff. A test covers this trap.
3. **The claim is re-checked.** The candidate list is a snapshot and can be stale. For example, an earlier
   event may have been released for retry after the list was built. So after a successful claim, the worker
   checks that no earlier pending event exists for that patient. If one does, it hands the claim back.
   Once the claim holds the patient's single slot in the index, nothing else of that patient can change
   state, so this check is stable.

Patients that already have an event in flight are excluded from the candidate list. The index would
reject them anyway, but their events are the oldest waiting. If they stayed in, they would fill the
list and starve idle slots.

**Out-of-order arrival.** The order is event time (`ts`), not arrival time.

- Each new event waits a grace window (`GRACE_MS`, 2 s) before it becomes claimable. An earlier event
  that arrives slightly late still becomes the head and is applied first.
- An event that arrives after later events were already applied is still processed. It is flagged
  `outOfOrder: true`, and `patientSeq` records the order in which events were actually applied.
  → **Trade-offs:**
- One patient is capped at about 12 events/min (60 s / 5 s). Sustaining 1000/min therefore needs at
  least 84 patients active at once.
- The grace window adds 2 s of latency to every event.
- Patient state is not corrected after a late event, because that is a clinical decision (see Known limits).

### Crashes mid-work

_Processes are killed at arbitrary moments, including mid-processing._
→ **Leases.** A claim sets `leaseOwner` (a unique worker ID made of host, pid and random bytes) and
`leaseUntil = now + LEASE_MS` (30 s). Before claiming new work, each slot first takes over any
`processing` event whose lease has expired. The event keeps its `processing` status, and therefore its
patient's slot in the index, so nothing overtakes it while its worker is dead.

→ **Fencing.** Every write that finishes a claim (complete, retry, fail, release) matches on
`{_id, status:'processing', leaseOwner, attempts}`. `attempts` is incremented on every claim and
takeover and never decreases, so a superseded lease can never match again. `leaseOwner` alone would not
be enough: all slots of a process share one worker ID. When the write matches nothing, the worker lost
its lease. It logs the loss and discards its result, and the document is left untouched.

→ **Time limits.** The external call has a hard timeout (`EXTERNAL_TIMEOUT_MS`, 15 s). Config validation
refuses a timeout that is not below `LEASE_MS`, so a healthy call always finishes inside its lease.

→ **Poison pills.** An event can make every worker that tries it crash or hang. Each takeover increments
its attempts, so once they exceed `MAX_ATTEMPTS` the event is marked `failed` without being processed again.

→ **Graceful shutdown.** Graceful shutdown is an optimisation; the leases are the actual guarantee. On
SIGTERM a worker stops claiming and gives in-flight events `SHUTDOWN_GRACE_MS` (8 s, below Docker's
10 s) to finish. It then aborts the remaining calls and releases their leases without counting them as
failures.

→ **Trade-off:** the external call can run twice for the same event, for example when a worker dies after
the call but before its write. The _stored_ outcome is exactly-once. The _external side effect_ is
at-least-once. The event `_id` is passed to the processor as an idempotency key, so a real external
system can deduplicate on its side.

### Failures

_The external system is slow and sometimes fails._
→ A failed attempt goes back to `pending` with `availableAt = now + backoff(attempts)`. The backoff is
exponential from 1 s, capped at 30 s, with "equal jitter" (`src/processing/backoff.ts`): half of the delay
is fixed and half is random, so retries spread out instead of hitting a recovering system in waves.
After `MAX_ATTEMPTS` (5) the event becomes `failed` and keeps its `lastError`. It is never deleted.
→ **Trade-off:** while an event is being retried, its patient waits, because it is still the head. Once
the event is marked `failed`, the patient continues with its next event. I chose availability here. The
alternative is to block the patient until a human resolves the failed event, which is stricter but
lets one bad event stall a patient's feed indefinitely. Either is a clinical/product decision, and the
choice is one line in `ClaimRepository.findHeads`. `failed` events are easy to find and replay.

### Why MongoDB as the queue, not Redis/BullMQ/Kafka (for now)

- One insert means the event is stored and enqueued at the same time. With a separate broker I would need
  an outbox or transactions to avoid dual-write gaps, which are exactly where clinical events get lost.
- Redis with default persistence can lose about 1 s of writes that were already acknowledged, and that is
  not acceptable for data we already said `202` to.
- The brief asks for one collection, and MongoDB already provides everything needed: atomic
  `findOneAndUpdate`, partial unique indexes and majority writes.
- **Trade-off:** workers poll instead of being pushed, and the head aggregation scans the pending backlog.
  At 1000 events/min the backlog stays small, so polling is fine. This is the first thing to change as
  load grows (see below).

### Growth

- The API and the workers are stateless: scale them with `--scale worker=N`. The limit is MongoDB and the
  number of active patients, not the processes.
- The backpressure signal is `oldestPendingAgeMs` in `GET /stats`. If it grows, workers are not keeping up.
- What breaks first is the polling cost: every idle slot runs a `distinct` plus an aggregation over pending
  events. The next steps, in order:
  1. Batch claims: one poll per process that feeds all of its idle slots.
  2. Change streams to wake workers instead of polling.
  3. Shard the collection by `patientId`. All per-patient invariants are single-shard, because the
     partial unique index is keyed by `patientId`.
  4. At much higher volume, move to Kafka partitioned by `patientId` with a transactional outbox from
     this collection.

## Known limits (stated up front)

- **12 events/min per patient.** Events are processed one at a time per patient, at ~5 s each. Throughput
  above that needs many patients active at once: at least 84 for 1000/min. A single very chatty patient
  builds a backlog, which is visible in `oldestPendingAgeMs`.
- **Late events are flagged, not corrected.** A late event that misses the grace window is applied after
  newer ones and marked `outOfOrder`. Recomputing a patient's state is a clinical decision.
- **The external side effect is at-least-once**, as explained above. The event `_id` is the idempotency key.
- **The dedup window is the retention window**, and payload changes between retries are not detected.
- **`attempts` counts claims, not only failures.** An event released at shutdown, or handed back by the
  stale-candidate re-check (rare), uses up one attempt. This keeps the fencing token strictly
  increasing, which I consider the more important property.
- **Lease expiry depends on wall-clock time across workers.** Clock skew between hosts shifts takeovers.
  Leases are 30 s, so skew of a few ms under NTP does not matter.
- **The head aggregation cost grows with the pending backlog**, and the `leaseTakeovers` stat scans the
  collection. Both are fine at this scale; at larger scale the stat belongs in metrics.

## Configuration

All timings and limits are typed and validated at startup (`src/config/config.ts`).

| Variable                         | Default                                           | Meaning                                                                 |
| -------------------------------- | ------------------------------------------------- | ----------------------------------------------------------------------- |
| `MONGO_URI`                      | `mongodb://localhost:27017/ingest?replicaSet=rs0` | must point at a replica set                                             |
| `MONGO_TIMEOUT_MS`               | 5000                                              | wait for a primary before failing (API answers 503)                     |
| `PORT`                           | 3000                                              | API port                                                                |
| `WORKER_CONCURRENCY`             | 40                                                | slots per worker process                                                |
| `LEASE_MS`                       | 30000                                             | lease duration before another worker may take over                      |
| `EXTERNAL_TIMEOUT_MS`            | 15000                                             | hard timeout of one external call; must be < `LEASE_MS`                 |
| `PROCESSING_DELAY_MS`            | 5000                                              | simulated external call duration                                        |
| `MAX_ATTEMPTS`                   | 5                                                 | attempts before `failed`                                                |
| `RETRY_BASE_MS` / `RETRY_MAX_MS` | 1000 / 30000                                      | retry backoff                                                           |
| `GRACE_MS`                       | 2000                                              | delay before a new event is claimable (late-arrival window); 0 disables |
| `POLL_INTERVAL_MS`               | 1000                                              | idle poll interval (jittered)                                           |
| `HEAD_CANDIDATES`                | 20                                                | heads fetched per poll                                                  |
| `SHUTDOWN_GRACE_MS`              | 8000                                              | in-flight time allowed on SIGTERM                                       |
| `FAKE_FAILURE_RATE`              | 0                                                 | share of fake external calls that fail (compose sets 0.05 for the demo) |

## Tests

`npm test` runs 77 tests: pure unit tests (`*.spec.ts`) and integration tests (`*.int-spec.ts`). The
integration tests run against a real MongoDB replica set started by `mongodb-memory-server`, with
majority/journaled writes and the real indexes. Nothing is mocked except the external system (a
controllable stub processor) and, where time matters, the clock.

The risky parts, and the tests that cover them:

| Risk       | Test                                                                                                                                                                                                                                      |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| duplicates | the same event POSTed 20× concurrently → 1 document, one id; retries with reordered keys and equivalent timestamps are duplicates                                                                                                         |
| dedup key  | key-order and timestamp-format independence; array order and every field matter                                                                                                                                                           |
| ordering   | concurrent claims → one winner; a patient never has two events in flight; out-of-order inserts are claimed in `ts` order; stale candidate refused; head in backoff blocks the next event; grace window lets a late earlier event go first |
| crashes    | expired lease taken over with attempts incremented; zombie finalize after takeover (or re-claim) is rejected and the document untouched; poison pill failed without reprocessing; shutdown finishes or releases in-flight work            |
| failures   | retry then success; `failed` after `MAX_ATTEMPTS`, still present; a retrying head is never overtaken                                                                                                                                      |
| durability | MongoDB down → `503`                                                                                                                                                                                                                      |
| sequencing | `patientSeq` 1..n per patient; `outOfOrder` compared against the latest applied `ts`                                                                                                                                                      |

## Layout

```
src/
  main.api.ts, main.worker.ts        two entrypoints, one image
  app/                               ApiModule, WorkerModule, /health
  config/                            typed env config
  common/                            Clock, error helpers
  database/                          connection + write concern
  events/                            schema + indexes, DTO, dedup key, POST/GET /events, ingest
  processing/                        claim protocol (claim.repository.ts), worker loop, backoff, processor
  stats/                             GET /stats
test/                                unit + integration tests
scripts/                             load.ts, verify.ts, chaos.sh
```

## With more time

- **Batched claims:** one poll per process feeding all idle slots, instead of one per idle slot.
- **Change streams** to wake idle workers instead of polling.
- **A per-sender `Idempotency-Key` contract**, so that a sender that mutates payloads between retries is
  still deduplicated.
- **Batching per patient:** apply a patient's queued events in one external call, if the external system
  allows it. This removes the 12/min per-patient ceiling.
- **Sharding by `patientId`**, then Kafka partitioned by patient with a transactional outbox, as volume grows.
- **Metrics and alerting** (Prometheus/OpenTelemetry): oldest pending age, failed count, takeovers, lease
  losses, external latency. A replay endpoint for `failed` events.
- **A clinical decision** on late events (recompute vs flag) and on failed heads (continue vs block the patient).
- **Retention:** TTL or archival of completed events, and with it a decision on how long dedup must hold.
