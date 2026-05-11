import pino from 'pino';
import { config } from '../config.js';

export const log = pino(
  config.LOG_PRETTY
    ? {
        level: config.LOG_LEVEL,
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l' },
        },
      }
    : { level: config.LOG_LEVEL },
);
