import { Module, OnModuleInit } from '@nestjs/common';
import { InjectModel, MongooseModule } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { EventRecord, EventSchema } from './event.schema';

/**
 * Registers the shared events model. The collection is the contract between the API and the
 * workers, so every module that needs it imports this one instead of redeclaring the schema.
 */
@Module({
  imports: [MongooseModule.forFeature([{ name: EventRecord.name, schema: EventSchema }])],
  exports: [MongooseModule],
})
export class EventModelModule implements OnModuleInit {
  constructor(@InjectModel(EventRecord.name) private readonly model: Model<EventRecord>) {}

  /** Blocks startup until the indexes exist: the partial unique index is what keeps per-patient ordering safe. */
  async onModuleInit(): Promise<void> {
    await this.model.createIndexes();
  }
}
