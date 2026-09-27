import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ApiModule } from './app/api.module';
import { APP_CONFIG, AppConfig } from './config/config';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(ApiModule);
  app.enableShutdownHooks();
  await app.listen(app.get<AppConfig>(APP_CONFIG).port);
}

void bootstrap();
