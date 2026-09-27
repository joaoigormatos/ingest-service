import { Clock } from '../../src/common/clock';

/** A clock tests move by hand, so lease expiry needs no sleeping. */
export class FakeClock implements Clock {
  private current: number;

  constructor(start = new Date('2026-01-01T00:00:00Z')) {
    this.current = start.getTime();
  }

  now(): Date {
    return new Date(this.current);
  }

  advance(ms: number): void {
    this.current += ms;
  }
}
