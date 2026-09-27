/** Source of "now". Injected so lease and backoff logic can be tested without sleeping. */
export interface Clock {
  now(): Date;
}

export const CLOCK = Symbol('CLOCK');

export const systemClock: Clock = { now: () => new Date() };
