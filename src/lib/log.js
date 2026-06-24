// Structured logger. Pretty in dev, JSON in production (good for hosting platforms' log viewers).
import pino from 'pino';
import { config } from './config.js';

export const log = pino({
  level: config.env === 'production' ? 'info' : 'debug',
  ...(config.env !== 'production'
    ? { transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:HH:MM:ss' } } }
    : {}),
});
