/**
 * Checks, straight from MongoDB, that the run recorded in manifest.json held up: every event stored
 * exactly once, nothing extra, everything settled, and each patient's events applied in order.
 *
 *   npm run verify -- [--timeout 900] [--mongo mongodb://localhost:27017/ingest?directConnection=true]
 */
import { readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import mongoose from 'mongoose';
import type { EventRecord } from '../src/events/event.schema';
import { Manifest, percentile } from './manifest';

const { values } = parseArgs({
  options: {
    // directConnection: the replica set advertises the in-network host name "mongo", unknown to the host.
    mongo: { type: 'string', default: 'mongodb://localhost:27017/ingest?directConnection=true' },
    timeout: { type: 'string', default: '900' },
  },
});

type StoredEvent = Pick<
  EventRecord,
  | 'dedupKey'
  | 'patientId'
  | 'ts'
  | 'status'
  | 'receivedAt'
  | 'completedAt'
  | 'attempts'
  | 'takeovers'
  | 'patientSeq'
  | 'outOfOrder'
>;

/** What was already applied for a patient before this run (the stack may have served earlier runs). */
interface History {
  readonly lastSeq: number;
  readonly latestTs: number;
}

interface Check {
  readonly name: string;
  readonly problems: readonly string[];
}

async function waitUntilSettled(
  events: mongoose.mongo.Collection<StoredEvent>,
  since: Date,
): Promise<void> {
  const deadline = Date.now() + Number(values.timeout) * 1000;
  for (;;) {
    const open = await events.countDocuments({
      receivedAt: { $gte: since },
      status: { $in: ['pending', 'processing'] },
    });
    if (open === 0) return;
    if (Date.now() > deadline) {
      throw new Error(`${open} events still pending/processing after ${values.timeout}s`);
    }
    console.log(`  waiting: ${open} events pending or processing`);
    await sleep(5000);
  }
}

function checkStoredExactlyOnce(manifest: Manifest, stored: readonly StoredEvent[]): Check {
  const copies = new Map<string, number>();
  for (const event of stored) copies.set(event.dedupKey, (copies.get(event.dedupKey) ?? 0) + 1);
  const problems = manifest.events.flatMap((entry) => {
    const count = copies.get(entry.dedupKey) ?? 0;
    const ok = entry.acknowledged ? count === 1 : count <= 1;
    return ok ? [] : [`${entry.patientId} ${entry.ts}: stored ${count} times`];
  });
  return { name: 'every acknowledged event is stored exactly once', problems };
}

function checkNoExtraEvents(manifest: Manifest, stored: readonly StoredEvent[]): Check {
  const known = new Set(manifest.events.map((entry) => entry.dedupKey));
  const problems = stored
    .filter((event) => !known.has(event.dedupKey))
    .map((event) => `${event.patientId} ${event.ts.toISOString()}: not in manifest`);
  return { name: 'no events other than the ones sent', problems };
}

function checkAllSettled(stored: readonly StoredEvent[]): Check {
  const problems = stored
    .filter((event) => event.status !== 'completed' && event.status !== 'failed')
    .map((event) => `${event.patientId} ${event.ts.toISOString()}: still ${event.status}`);
  return { name: 'every event is completed or failed', problems };
}

/**
 * patientSeq continues without gaps from the patient's history, and ts never goes backwards along it
 * unless the event is flagged outOfOrder.
 */
function checkPatientOrder(stored: readonly StoredEvent[], history: Map<string, History>): Check {
  const byPatient = new Map<string, StoredEvent[]>();
  for (const event of stored.filter((e) => e.status === 'completed')) {
    byPatient.set(event.patientId, [...(byPatient.get(event.patientId) ?? []), event]);
  }
  const problems: string[] = [];
  for (const [patientId, events] of byPatient) {
    const applied = [...events].sort((a, b) => (a.patientSeq ?? 0) - (b.patientSeq ?? 0));
    const before = history.get(patientId) ?? { lastSeq: 0, latestTs: 0 };
    let latestTs = before.latestTs;
    applied.forEach((event, i) => {
      const ts = event.ts.getTime();
      const late = ts < latestTs;
      const expectedSeq = before.lastSeq + i + 1;
      if (event.patientSeq !== expectedSeq) {
        problems.push(`${patientId}: expected patientSeq ${expectedSeq}, got ${event.patientSeq}`);
      }
      if (late !== Boolean(event.outOfOrder)) {
        problems.push(`${patientId} seq ${event.patientSeq}: outOfOrder flag wrong`);
      }
      latestTs = Math.max(latestTs, ts);
    });
  }
  return {
    name: 'per patient: patientSeq contiguous, ts in order except flagged late events',
    problems,
  };
}

function printSummary(manifest: Manifest, stored: readonly StoredEvent[]): void {
  const completed = stored.filter((event) => event.status === 'completed');
  const start = Math.min(...stored.map((event) => event.receivedAt.getTime()));
  const end = Math.max(...completed.map((event) => event.completedAt?.getTime() ?? 0));
  const endToEnd = completed.map(
    (event) => (event.completedAt?.getTime() ?? 0) - event.receivedAt.getTime(),
  );
  const { report } = manifest;
  console.log(`
  events sent (unique)        ${report.uniqueEvents}   (${report.requests} HTTP requests)
  stored                      ${stored.length}
  completed / failed          ${completed.length} / ${stored.filter((event) => event.status === 'failed').length}
  throughput                  ${Math.round((completed.length / (end - start)) * 60_000)} events/min
  ingest latency p50 / p99    ${report.ingestLatencyMs.p50} ms / ${report.ingestLatencyMs.p99} ms
  received->completed p50/p99 ${percentile(endToEnd, 50)} ms / ${percentile(endToEnd, 99)} ms
  duplicates absorbed         ${report.duplicateResponses}
  abandoned requests          ${report.earlyAborts}
  sender retries              ${report.retries}   (undelivered: ${report.undelivered})
  events retried by workers   ${stored.filter((event) => event.attempts > 1).length}
  lease takeovers             ${stored.reduce((sum, event) => sum + (event.takeovers ?? 0), 0)}
  applied out of order        ${stored.filter((event) => event.outOfOrder).length}
`);
}

async function loadHistory(
  events: mongoose.mongo.Collection<StoredEvent>,
  since: Date,
): Promise<Map<string, History>> {
  const rows = await events
    .aggregate<{ _id: string; lastSeq: number; latestTs: Date }>([
      { $match: { receivedAt: { $lt: since }, status: 'completed' } },
      {
        $group: { _id: '$patientId', lastSeq: { $max: '$patientSeq' }, latestTs: { $max: '$ts' } },
      },
    ])
    .toArray();
  return new Map(
    rows.map((row) => [row._id, { lastSeq: row.lastSeq, latestTs: row.latestTs.getTime() }]),
  );
}

async function main(): Promise<void> {
  const manifest = JSON.parse(readFileSync('manifest.json', 'utf8')) as Manifest;
  const since = new Date(manifest.report.startedAt);
  const connection = await mongoose.createConnection(values.mongo).asPromise();
  const events = connection.getClient().db().collection<StoredEvent>('events');

  await waitUntilSettled(events, since);
  const stored = await events.find({ receivedAt: { $gte: since } }).toArray();
  const history = await loadHistory(events, since);
  await connection.close();

  const checks = [
    checkStoredExactlyOnce(manifest, stored),
    checkNoExtraEvents(manifest, stored),
    checkAllSettled(stored),
    checkPatientOrder(stored, history),
  ];
  for (const check of checks) {
    console.log(`${check.problems.length === 0 ? 'PASS' : 'FAIL'}  ${check.name}`);
    check.problems.slice(0, 5).forEach((problem) => console.log(`      ${problem}`));
  }
  printSummary(manifest, stored);
  process.exit(checks.every((check) => check.problems.length === 0) ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
