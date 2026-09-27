import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  NotFoundException,
  Param,
  Post,
  ServiceUnavailableException,
  ValidationPipe,
} from '@nestjs/common';
import { describeError } from '../common/errors';
import { CreateEventDto } from './event.dto';
import { EventDocument } from './event.schema';
import { EventsRepository } from './events.repository';
import { IngestResult, IngestService } from './ingest.service';

const OBJECT_ID = /^[0-9a-f]{24}$/i;

@Controller('events')
export class EventsController {
  private readonly logger = new Logger(EventsController.name);

  constructor(
    private readonly ingestService: IngestService,
    private readonly events: EventsRepository,
  ) {}

  /** 202 only after the event is durably stored; processing happens later, in the workers. */
  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  async create(
    // whitelist drops unknown fields so they can neither be stored nor affect the dedup key.
    @Body(new ValidationPipe({ whitelist: true })) dto: CreateEventDto,
  ): Promise<IngestResult> {
    try {
      return await this.ingestService.ingest(dto);
    } catch (error) {
      // Not stored (or unsure): 503 tells the sender to retry, and dedup makes the retry safe.
      this.logger.error(
        `event not stored patientId=${dto.patientId} ts=${dto.ts}: ${describeError(error)}`,
      );
      throw new ServiceUnavailableException('Event was not stored; retry with the same body');
    }
  }

  @Get(':id')
  async findOne(@Param('id') id: string): Promise<EventDocument> {
    const event = OBJECT_ID.test(id) ? await this.events.findById(id) : null;
    if (!event) throw new NotFoundException(`event ${id} not found`);
    return event;
  }
}
