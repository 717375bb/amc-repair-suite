import pino from 'pino';

/**
 * B1: single shared Pino instance. Structured JSON always at the base
 * level; pino-pretty is layered on only when NODE_ENV isn't exactly
 * "production" — same "exact literal value" discipline this project
 * already uses for HEADLESS/MXI_ENV/SECRET_PROVIDER. Deliberately a
 * separate signal from MXI_ENV: MXI_ENV picks which Maintenix environment
 * gets written to (you can legitimately run MXI_ENV=production from a
 * local dev session), NODE_ENV picks the log-output format — two
 * different axes, never conflated. Unset NODE_ENV (the common case for
 * this project — one analyst running `npm run server`/`npm run dev`
 * locally or in Codespaces) defaults to pretty/dev output.
 *
 * Both the default JSON path and the pino-pretty path use Pino's async
 * transport mechanism (worker-thread-based) rather than a synchronous
 * formatter/write, per B3/B1's performance intent — logging on a hot path
 * never blocks the event loop on I/O.
 */
const isProduction = process.env.NODE_ENV === 'production';

const rootLogger = pino({
  level: process.env.LOG_LEVEL || (isProduction ? 'info' : 'debug'),
  transport: isProduction
    ? undefined
    : {
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname' },
      },
});

/**
 * B1: a child logger bound with subsystem + call-site context
 * (runId/vendor/part/serial/orderNumber/etc.), so lines are correlatable
 * without manual string-building. Named subsystems from the prompt:
 * 'writeup', 'esd', 'api' — not restricted to only those three.
 */
export function createLogger(subsystem: string, context: Record<string, unknown> = {}) {
  return rootLogger.child({ subsystem, ...context });
}

export default rootLogger;
