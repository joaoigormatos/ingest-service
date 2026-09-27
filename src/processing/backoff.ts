export interface BackoffPolicy {
  readonly baseMs: number;
  readonly maxMs: number;
}

/**
 * Delay before retrying after failed attempt number `attempts` (1-based): exponential, capped,
 * with "equal jitter" (half fixed, half random). The fixed half keeps delays growing; the random
 * half spreads retries out so a recovering external system is not hit by a synchronized wave.
 */
export function backoffMs(
  attempts: number,
  policy: BackoffPolicy,
  random: () => number = Math.random,
): number {
  const exponential = Math.min(policy.maxMs, policy.baseMs * 2 ** (attempts - 1));
  return Math.round(exponential / 2 + random() * (exponential / 2));
}
