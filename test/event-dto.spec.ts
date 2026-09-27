import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateEventDto } from '../src/events/event.dto';

const valid = {
  patientId: 'patient-1',
  type: 'vitals',
  data: { heartRate: 72 },
  ts: '2026-01-01T10:00:00.000Z',
};

async function errorsFor(body: Record<string, unknown>): Promise<string[]> {
  const errors = await validate(plainToInstance(CreateEventDto, body));
  return errors.map((error) => error.property);
}

describe('CreateEventDto', () => {
  it('accepts a well-formed event', async () => {
    expect(await errorsFor(valid)).toEqual([]);
  });

  it('accepts timestamps with an explicit offset and fractional seconds', async () => {
    expect(await errorsFor({ ...valid, ts: '2026-01-01T12:00:00.123+02:00' })).toEqual([]);
  });

  it('accepts an empty data object', async () => {
    expect(await errorsFor({ ...valid, data: {} })).toEqual([]);
  });

  it.each([
    ['missing patientId', { ...valid, patientId: undefined }, 'patientId'],
    ['empty patientId', { ...valid, patientId: '' }, 'patientId'],
    ['non-string type', { ...valid, type: 42 }, 'type'],
    ['array data', { ...valid, data: [1, 2] }, 'data'],
    ['null data', { ...valid, data: null }, 'data'],
    ['string data', { ...valid, data: 'x' }, 'data'],
    ['non-date ts', { ...valid, ts: 'yesterday' }, 'ts'],
    ['date-only ts', { ...valid, ts: '2026-01-01' }, 'ts'],
    ['ts without timezone', { ...valid, ts: '2026-01-01T10:00:00' }, 'ts'],
  ])('rejects %s', async (_name, body, property) => {
    expect(await errorsFor(body)).toEqual([property]);
  });
});
