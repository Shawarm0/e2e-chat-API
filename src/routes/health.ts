import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { redis } from '../redis/client.js';

const HEALTH_TIMEOUT_MS = 2000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('timeout')), ms),
    ),
  ]);
}

async function checkPostgres(): Promise<'ok' | 'error'> {
  try {
    await withTimeout(db.execute(sql`SELECT 1`), HEALTH_TIMEOUT_MS);
    return 'ok';
  } catch {
    return 'error';
  }
}

async function checkRedis(): Promise<'ok' | 'error'> {
  try {
    await withTimeout(redis.ping(), HEALTH_TIMEOUT_MS);
    return 'ok';
  } catch {
    return 'error';
  }
}

async function deepCheck(): Promise<{ ok: boolean; postgres: string; redis: string }> {
  const [pgStatus, redisStatus] = await Promise.all([checkPostgres(), checkRedis()]);
  return {
    ok: pgStatus === 'ok' && redisStatus === 'ok',
    postgres: pgStatus,
    redis: redisStatus,
  };
}

export async function healthRoutes(fastify: FastifyInstance) {
  fastify.get('/health', async (_request, reply) => {
    const result = await deepCheck();
    return reply.code(result.ok ? 200 : 503).send(result);
  });

  fastify.get('/ready', async (_request, reply) => {
    const result = await deepCheck();
    return reply.code(result.ok ? 200 : 503).send(result);
  });
}
