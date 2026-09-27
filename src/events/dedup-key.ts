import { createHash } from 'node:crypto';

export interface DedupInput {
  readonly patientId: string;
  readonly type: string;
  readonly ts: Date;
  readonly data: Record<string, unknown>;
}

/**
 * Identity of an event when the sender provides no ID: sha256 of its canonical content.
 * Two deliveries with the same patient, type, instant and data are the same event,
 * however the JSON was spelled (key order, timestamp format).
 */
export function computeDedupKey(input: DedupInput): string {
  const canonical = canonicalJson({
    patientId: input.patientId,
    type: input.type,
    // Normalises "Z", "+00:00", ".000" and other offsets to one spelling of the instant.
    ts: input.ts.toISOString(),
    data: input.data,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

/** JSON with object keys sorted at every level; array order is kept because it carries meaning. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value === null || typeof value !== 'object') return value;
  const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return Object.fromEntries(entries.map(([key, child]) => [key, sortKeys(child)]));
}
