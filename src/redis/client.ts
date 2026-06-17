import { Redis } from 'ioredis';
import { logger } from '../logger.js';

const redisUrl = process.env.REDIS_URL;
if (!redisUrl) {
  throw new Error('REDIS_URL is not set');
}

export const redis = new Redis(redisUrl, {
  maxRetriesPerRequest: 3,
  enableReadyCheck: true,
});

redis.on('error', (err: Error) => {
  logger.error({ err }, 'Redis connection error');
});
