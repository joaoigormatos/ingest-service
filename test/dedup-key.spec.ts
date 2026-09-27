import { computeDedupKey } from '../src/events/dedup-key';

const base = {
  patientId: 'patient-1',
  type: 'vitals',
  ts: new Date('2026-01-01T10:00:00Z'),
  data: { heartRate: 72, bp: { systolic: 120, diastolic: 80 }, tags: ['a', 'b'] },
};

describe('computeDedupKey', () => {
  it('is a sha256 hex digest', () => {
    expect(computeDedupKey(base)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('ignores object key order, including nested objects', () => {
    const reordered = {
      ...base,
      data: { tags: ['a', 'b'], bp: { diastolic: 80, systolic: 120 }, heartRate: 72 },
    };

    expect(computeDedupKey(reordered)).toBe(computeDedupKey(base));
  });

  it('treats equivalent spellings of the same instant as equal', () => {
    const spellings = [
      '2026-01-01T10:00:00Z',
      '2026-01-01T10:00:00.000Z',
      '2026-01-01T10:00:00+00:00',
      '2026-01-01T12:00:00+02:00',
    ];

    const keys = spellings.map((ts) => computeDedupKey({ ...base, ts: new Date(ts) }));

    expect(new Set(keys).size).toBe(1);
  });

  it('changes when the data changes', () => {
    expect(computeDedupKey({ ...base, data: { ...base.data, heartRate: 73 } })).not.toBe(
      computeDedupKey(base),
    );
  });

  it('changes when the patient, type or time changes', () => {
    const key = computeDedupKey(base);

    expect(computeDedupKey({ ...base, patientId: 'patient-2' })).not.toBe(key);
    expect(computeDedupKey({ ...base, type: 'labs' })).not.toBe(key);
    expect(computeDedupKey({ ...base, ts: new Date('2026-01-01T10:00:01Z') })).not.toBe(key);
  });

  it('treats array order as meaningful', () => {
    expect(computeDedupKey({ ...base, data: { ...base.data, tags: ['b', 'a'] } })).not.toBe(
      computeDedupKey(base),
    );
  });
});
