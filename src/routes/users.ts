import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { users } from '../db/schema.js';
import { requireAuth } from '../auth/requireAuth.js';
import { checkRateLimit } from '../ratelimit/limiter.js';
import { validateAndNormalizePhone } from '../validation/phone.js';

const lookupQuerySchema = z.object({
  phoneNumber: z.string().min(1),
});

export async function userRoutes(fastify: FastifyInstance) {
  fastify.get('/users/lookup', { onRequest: [requireAuth] }, async (request, reply) => {
    const userId = request.session!.userId;

    const parsed = lookupQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'phoneNumber query parameter is required' });
    }

    const phoneResult = validateAndNormalizePhone(parsed.data.phoneNumber);
    if (!phoneResult.valid) {
      return reply.code(400).send({ error: phoneResult.reason });
    }

    const rl = await checkRateLimit({
      key: `rl:user:lookup:${userId}`,
      limit: 30,
      windowSeconds: 3600,
    });
    if (!rl.allowed) {
      return reply
        .code(429)
        .header('Retry-After', String(rl.retryAfterSeconds))
        .send({ error: `Too many requests, try again in ${rl.retryAfterSeconds} seconds` });
    }

    const [user] = await db
      .select({
        id: users.id,
        phoneNumber: users.phoneNumber,
        displayName: users.displayName,
      })
      .from(users)
      .where(eq(users.phoneNumber, phoneResult.e164))
      .limit(1);

    if (!user) {
      return reply.code(404).send({ error: 'User not found' });
    }

    return { user };
  });
}
