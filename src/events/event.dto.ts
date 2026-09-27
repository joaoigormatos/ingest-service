import { IsISO8601, IsNotEmpty, IsObject, IsString, Matches } from 'class-validator';

/** Explicit UTC designator or offset at the end of the timestamp. */
const HAS_TIMEZONE = /(Z|[+-]\d{2}:?\d{2})$/i;

export class CreateEventDto {
  @IsString()
  @IsNotEmpty()
  readonly patientId!: string;

  @IsString()
  @IsNotEmpty()
  readonly type!: string;

  @IsObject()
  readonly data!: Record<string, unknown>;

  @IsISO8601({ strict: true })
  // Without a timezone the instant is ambiguous (parsed as server-local time), which would
  // corrupt both per-patient ordering and the dedup key. Senders must say which instant they mean.
  @Matches(HAS_TIMEZONE, { message: 'ts must include a timezone (Z or ±hh:mm)' })
  readonly ts!: string;
}
