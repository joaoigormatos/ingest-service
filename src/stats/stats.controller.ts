import { Controller, Get } from '@nestjs/common';
import { Stats, StatsRepository } from './stats.repository';

@Controller('stats')
export class StatsController {
  constructor(private readonly stats: StatsRepository) {}

  @Get()
  snapshot(): Promise<Stats> {
    return this.stats.snapshot();
  }
}
