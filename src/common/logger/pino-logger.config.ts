import { randomUUID } from 'crypto';
import { IncomingMessage, ServerResponse } from 'http';
import { ConfigService } from '@nestjs/config';
import { Params } from 'nestjs-pino';
import { CORRELATION_ID_HEADER } from '../middleware/correlation-id.middleware';

/**
 * `pino-http`/`nestjs-pino` factory shared by `AppModule`.
 *
 * - Every request/response log line carries `correlationId`, `level`,
 *   `timestamp` (pino's default `time`) and `context` out of the box.
 * - `genReqId` re-uses the `x-correlation-id` header set by
 *   `CorrelationIdMiddleware` (task 01) when it runs first, or generates one
 *   itself (which `CorrelationIdMiddleware` then re-uses) when it runs
 *   first — see the comment in that middleware for why this is safe either
 *   way.
 * - JSON logs in production, pretty-printed logs everywhere else.
 */
export function createPinoLoggerConfig(config: ConfigService): Params {
  const isProduction = config.get<string>('nodeEnv') === 'production';

  return {
    pinoHttp: {
      genReqId: (req: IncomingMessage, res: ServerResponse) => {
        const incoming = req.headers[CORRELATION_ID_HEADER];
        const correlationId =
          (Array.isArray(incoming) ? incoming[0] : incoming) || randomUUID();
        res.setHeader(CORRELATION_ID_HEADER, correlationId);
        return correlationId;
      },
      customProps: (req: IncomingMessage) => ({
        correlationId: (req as unknown as { id?: string }).id,
      }),
      // Keep default `req`/`res` serializers but avoid dumping full headers
      // (auth tokens, cookies) into every log line.
      serializers: {
        req: (req: Record<string, unknown>) => ({
          id: req.id,
          method: req.method,
          url: req.url,
        }),
        res: (res: Record<string, unknown>) => ({
          statusCode: res.statusCode,
        }),
      },
      customSuccessMessage: (
        req: IncomingMessage,
        res: ServerResponse,
        responseTime: number,
      ) =>
        `${req.method} ${req.url} ${res.statusCode} - ${responseTime}ms`,
      customErrorMessage: (
        req: IncomingMessage,
        res: ServerResponse,
        error: Error,
      ) => `${req.method} ${req.url} ${res.statusCode} - ${error.message}`,
      level: isProduction ? 'info' : 'debug',
      transport: isProduction
        ? undefined
        : {
            target: 'pino-pretty',
            options: {
              singleLine: true,
              colorize: true,
              translateTime: 'HH:MM:ss.l',
              ignore: 'pid,hostname',
            },
          },
    },
  };
}
