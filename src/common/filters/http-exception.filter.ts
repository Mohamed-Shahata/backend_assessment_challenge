import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Inject,
} from '@nestjs/common';
import { Response } from 'express';
import { Logger } from 'nestjs-pino';
import { RequestWithCorrelationId } from '../middleware/correlation-id.middleware';

interface UnifiedErrorResponse {
  statusCode: number;
  message: string | string[];
  error: string;
  correlationId: string;
  timestamp: string;
}

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  constructor(@Inject(Logger) private readonly logger: Logger) {}

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<RequestWithCorrelationId>();
    const correlationId = request.correlationId ?? 'unknown';

    let statusCode = HttpStatus.INTERNAL_SERVER_ERROR;
    let message: string | string[] = 'Internal server error';
    let error = 'Internal Server Error';

    if (exception instanceof HttpException) {
      statusCode = exception.getStatus();
      const res = exception.getResponse();
      if (typeof res === 'string') {
        message = res;
        error = exception.name;
      } else if (typeof res === 'object' && res !== null) {
        const resObj = res as Record<string, unknown>;
        message = (resObj.message as string | string[]) ?? exception.message;
        error = (resObj.error as string) ?? exception.name;
      }
    } else if (exception instanceof Error) {
      message = exception.message;
      error = exception.name;
    }

    const body: UnifiedErrorResponse = {
      statusCode,
      message,
      error,
      correlationId,
      timestamp: new Date().toISOString(),
    };

    // Known, intentional 4xx responses (validation errors, "not found",
    // business-rule rejections, etc.) are expected traffic - log them at
    // `warn` without a stack trace. Anything else (a genuine 500, or a raw
    // Error that wasn't turned into an HttpException) is unexpected and is
    // logged at `error` with the full stack trace so it's actually visible
    // server-side, not just returned to the client.
    const isKnownClientError =
      exception instanceof HttpException &&
      statusCode < HttpStatus.INTERNAL_SERVER_ERROR;
    const logMessage = `${statusCode} ${JSON.stringify(message)}`;

    if (isKnownClientError) {
      this.logger.warn(
        { correlationId, statusCode, msg: logMessage },
        HttpExceptionFilter.name,
      );
    } else {
      this.logger.error(
        {
          correlationId,
          statusCode,
          stack: exception instanceof Error ? exception.stack : undefined,
          msg: logMessage,
        },
        HttpExceptionFilter.name,
      );
    }

    response.status(statusCode).json(body);
  }
}
