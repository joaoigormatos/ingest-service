/**
 * Load generator that behaves like the third-party senders in the brief: sustained rate, per-patient
 * increasing event times delivered slightly out of order, duplicates (some concurrent), requests
 * abandoned mid-flight and retried, and retries on timeouts / 5xx / connection errors.
 *
 * Writes manifest.json: every unique event sent (for scripts/verify.ts) plus run statistics.
 *
 *   npm run load -- --patients 300 --rate 1000 --minutes 5 [--url http://localhost:3000]
 */
import { writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { computeDedupKey } from '../src/events/dedup-key';
import { LoadReport, Manifest, ManifestEntry, percentile } from './manifest';

const { values } = parseArgs({
  options: {
    patients: { type: 'string', default: '300' },
    rate: { type: 'string', default: '1000' },
    minutes: { type: 'string', default: '5' },
    url: { type: 'string', default: 'http://localhost:3000' },
  },
});
const PATIENTS = Number(values.patients);
const RATE_PER_MIN = Number(values.rate);
const MINUTES = Number(values.minutes);
const EVENTS_URL = `${values.url}/events`;

const DUPLICATE_RATE = 0.1; // share of events delivered twice
const EARLY_ABORT_RATE = 0.02; // share of events whose first request is abandoned mid-flight
const SHUFFLE_WINDOW = 10; // events are shuffled within windows of this size (out-of-order delivery)
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_TRIES = 12; // retries cover an API restart during chaos testing
const MAX_RETRY_DELAY_MS = 5_000;

interface ClinicalEvent {
  readonly patientId: string;
  readonly type: string;
  readonly ts: string;
  readonly data: Record<string, unknown>;
}

const counters = { requests: 0, accepted: 0, duplicateResponses: 0, earlyAborts: 0, retries: 0 };
const latenciesMs: number[] = [];

/**
 * Event time = the moment the event is scheduled to be sent, so ts increases per patient, stays close to
 * real time and never overlaps an earlier run. Out-of-order delivery comes from shuffling, below.
 */
function generateEvents(total: number, startMs: number, intervalMs: number): ClinicalEvent[] {
  return Array.from({ length: total }, (_, n) => ({
    patientId: `patient-${Math.floor(Math.random() * PATIENTS)}`,
    type: n % 3 === 0 ? 'medication' : 'vitals',
    ts: new Date(startMs + n * intervalMs).toISOString(),
    data: { n, heartRate: 60 + Math.floor(Math.random() * 40) },
  }));
}

function shuffleWithinWindows<T>(items: readonly T[], size: number): T[] {
  const result: T[] = [];
  for (let start = 0; start < items.length; start += size) {
    const window = items.slice(start, start + size);
    for (let i = window.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [window[i], window[j]] = [window[j], window[i]];
    }
    result.push(...window);
  }
  return result;
}

function post(event: ClinicalEvent, signal: AbortSignal): Promise<Response> {
  counters.requests++;
  return fetch(EVENTS_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(event),
    signal,
  });
}

/** A sender that gives up on its first request almost immediately; the server may or may not have stored it. */
async function abandonEarly(event: ClinicalEvent): Promise<void> {
  counters.earlyAborts++;
  await post(event, AbortSignal.timeout(Math.floor(Math.random() * 5))).catch(() => undefined);
}

/** Retries timeouts, connection errors and 5xx until the event is acknowledged. False if it never was. */
async function deliver(event: ClinicalEvent): Promise<boolean> {
  for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
    if (await tryOnce(event)) return true;
    counters.retries++;
    await sleep(Math.min(MAX_RETRY_DELAY_MS, 100 * 2 ** attempt) * (0.5 + Math.random()));
  }
  return false;
}

async function tryOnce(event: ClinicalEvent): Promise<boolean> {
  const started = performance.now();
  const response = await post(event, AbortSignal.timeout(REQUEST_TIMEOUT_MS)).catch(() => null);
  if (!response) return false; // timed out or connection refused: retry
  if (response.status !== 202) {
    await response.body?.cancel();
    if (response.status >= 500) return false;
    throw new Error(`event rejected with ${response.status}: ${JSON.stringify(event)}`); // generator bug
  }
  latenciesMs.push(performance.now() - started);
  counters.accepted++;
  if (((await response.json()) as { duplicate: boolean }).duplicate) counters.duplicateResponses++;
  return true;
}

async function send(event: ClinicalEvent): Promise<boolean> {
  if (Math.random() < EARLY_ABORT_RATE) await abandonEarly(event);
  if (Math.random() >= DUPLICATE_RATE) return deliver(event);
  if (Math.random() < 0.5) {
    const [first, second] = await Promise.all([deliver(event), deliver(event)]); // concurrent duplicate
    return first || second;
  }
  const acknowledged = await deliver(event);
  await sleep(Math.random() * 3_000);
  return (await deliver(event)) || acknowledged; // late duplicate
}

function toManifestEntry(event: ClinicalEvent, acknowledged: boolean): ManifestEntry {
  const ts = new Date(event.ts);
  const dedupKey = computeDedupKey({ ...event, ts });
  return { dedupKey, patientId: event.patientId, ts: event.ts, acknowledged };
}

async function main(): Promise<void> {
  const intervalMs = 60_000 / RATE_PER_MIN;
  const startedAt = new Date();
  const generated = generateEvents(RATE_PER_MIN * MINUTES, startedAt.getTime(), intervalMs);
  const events = shuffleWithinWindows(generated, SHUFFLE_WINDOW);
  console.log(
    `sending ${events.length} events for ${PATIENTS} patients at ${RATE_PER_MIN}/min to ${EVENTS_URL}`,
  );

  const deliveries: Promise<boolean>[] = [];
  for (let i = 0; i < events.length; i++) {
    await sleep(Math.max(0, startedAt.getTime() + i * intervalMs - Date.now()));
    deliveries.push(send(events[i]));
    if ((i + 1) % RATE_PER_MIN === 0) console.log(`  ${i + 1}/${events.length} sent`, counters);
  }
  const acknowledged = await Promise.all(deliveries);

  const report: LoadReport = {
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    uniqueEvents: events.length,
    ...counters,
    undelivered: acknowledged.filter((ok) => !ok).length,
    ingestLatencyMs: { p50: percentile(latenciesMs, 50), p99: percentile(latenciesMs, 99) },
  };
  const manifest: Manifest = {
    report,
    events: events.map((event, i) => toManifestEntry(event, acknowledged[i])),
  };
  writeFileSync('manifest.json', JSON.stringify(manifest, null, 2));
  console.log('load finished; manifest.json written', report);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
