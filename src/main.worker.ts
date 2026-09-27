import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './app/worker.module';

async function bootstrap(): Promise<void> {
  // No HTTP server: a worker only talks to MongoDB and the external system.
  const app = await NestFactory.createApplicationContext(WorkerModule);
  app.enableShutdownHooks();
}

void bootstrap();
