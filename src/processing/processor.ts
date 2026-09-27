/** What the external system receives. `id` doubles as its idempotency key. */
export interface ProcessorInput {
  readonly id: string;
  readonly patientId: string;
  readonly type: string;
  readonly ts: Date;
  readonly data: Record<string, unknown>;
}

export type ProcessingResult = Record<string, unknown>;

/** The slow external system. The worker depends on this interface only; tests swap in a stub. */
export interface Processor {
  /** Must reject once `signal` aborts (hard timeout). */
  process(event: ProcessorInput, signal: AbortSignal): Promise<ProcessingResult>;
}

export const PROCESSOR = Symbol('PROCESSOR');
