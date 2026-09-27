import { backoffMs } from '../src/processing/backoff';

const policy = { baseMs: 1000, maxMs: 30000 };
const lowest = () => 0;
const highest = () => 1;

describe('backoffMs', () => {
  it('doubles with every attempt', () => {
    const delays = [1, 2, 3, 4].map((attempts) => backoffMs(attempts, policy, highest));

    expect(delays).toEqual([1000, 2000, 4000, 8000]);
  });

  it('never waits less after a later attempt below the cap, whatever the jitter', () => {
    // 2^4 * 1000 = 16000 is the last delay below maxMs; past the cap only the jitter varies.
    for (let attempts = 2; attempts <= 5; attempts++) {
      expect(backoffMs(attempts, policy, lowest)).toBeGreaterThanOrEqual(
        backoffMs(attempts - 1, policy, highest),
      );
    }
  });

  it('is capped at maxMs', () => {
    expect(backoffMs(20, policy, highest)).toBe(30000);
    expect(backoffMs(1000, policy, highest)).toBe(30000);
  });

  it('is jittered between half and all of the exponential delay', () => {
    expect(backoffMs(3, policy, lowest)).toBe(2000);
    expect(backoffMs(3, policy, () => 0.5)).toBe(3000);
    expect(backoffMs(3, policy, highest)).toBe(4000);
  });
});
