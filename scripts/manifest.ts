/** Contract between scripts/load.ts (writer) and scripts/verify.ts (reader). */

export interface ManifestEntry {
  readonly dedupKey: string;
  readonly patientId: string;
  readonly ts: string;
  /** False if the sender never got a 202: the event may or may not be stored, but at most once. */
  readonly acknowledged: boolean;
}

export interface LoadReport {
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly uniqueEvents: number;
  readonly requests: number;
  readonly accepted: number;
  readonly duplicateResponses: number;
  readonly earlyAborts: number;
  readonly retries: number;
  readonly undelivered: number;
  readonly ingestLatencyMs: { readonly p50: number; readonly p99: number };
}

export interface Manifest {
  readonly report: LoadReport;
  readonly events: readonly ManifestEntry[];
}

/** Nearest-rank percentile, rounded to whole milliseconds. */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)]);
}
