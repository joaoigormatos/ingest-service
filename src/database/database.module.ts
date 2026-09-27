import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { APP_CONFIG, AppConfig } from '../config/config';
import { mongoConnectionOptions } from './connection-options';

@Module({
  imports: [
    MongooseModule.forRootAsync({
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => ({
        uri: config.mongoUri,
        ...mongoConnectionOptions(config),
      }),
    }),
  ],
})
export class DatabaseModule {}
