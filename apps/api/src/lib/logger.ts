import pino from 'pino';
import { env, isProd, isTest } from '../env.js';

/** Keys never written to logs, anywhere. */
const REDACT = [
  'req.headers.cookie',
  'req.headers.authorization',
  'res.headers["set-cookie"]',
  '*.password',
  '*.passphrase',
  'req.body.passphrase',
  '*.passwordHash',
  '*.token',
  '*.tokenHash',
  '*.offerToken',
  '*.authToken',
  '*.callerPhone',
  '*.phone',
  '*.borrowerPhone',
  '*.passengerNotes',
];

export const logger = pino({
  level: isTest ? 'silent' : env.LOG_LEVEL,
  redact: { paths: REDACT, censor: '[redacted]' },
  base: { service: 'rvc-api', env: env.NODE_ENV },
  ...(isProd ? {} : { transport: { target: 'pino-pretty', options: { colorize: true } } }),
});

export type Logger = typeof logger;
