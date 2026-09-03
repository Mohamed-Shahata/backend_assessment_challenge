import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });

  // Use nestjs-pino (structured Pino logs: correlationId, level, timestamp,
  // context) as the app-wide logger instead of Nest's default console
  // logger. `bufferLogs: true` above holds any logs emitted during startup
  // until this is wired up, so nothing is lost/dropped to the console.
  app.useLogger(app.get(Logger));

  // Let Nest call `onModuleDestroy`/`beforeApplicationShutdown` on SIGTERM
  // (and friends) so PrismaService and the BullMQ queue connections close
  // cleanly instead of the process being killed mid-request.
  app.enableShutdownHooks();

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  app.useGlobalFilters(new HttpExceptionFilter(app.get(Logger)));

  const swaggerConfig = new DocumentBuilder()
    .setTitle('Digital Wallet & Flash-Sale Engine')
    .setDescription(
      'API documentation for the wallet, ledger, flash-sale and notification engine.',
    )
    .setVersion('1.0')
    .addBearerAuth()
    .build();
  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('api/docs', app, document);

  const port = process.env.PORT ?? 3000;
  await app.listen(port);
}
void bootstrap();
