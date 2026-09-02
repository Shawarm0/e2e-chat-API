import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { users } from '../db/schema.js';
import { requireAuth } from '../auth/requireAuth.js';
import { checkRateLimit } from '../ratelimit/limiter.js';
import { validateAndNormalizeEmail } from '../validation/email.js';

const lookupQuerySchema = z.object({
  email: z.string().min(1),
});

export async function userRoutes(fastify: FastifyInstance) {
  fastify.get('/users/lookup', { onRequest: [requireAuth] }, async (request, reply) => {
    const userId = request.session!.userId;

    const parsed = lookupQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'email query parameter is required' });
    }

    const emailResult = validateAndNormalizeEmail(parsed.data.email);
    if (!emailResult.valid) {
      return reply.code(400).send({ error: emailResult.reason });
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
        email: users.email,
        displayName: users.displayName,
      })
      .from(users)
      .where(eq(users.email, emailResult.email))
      .limit(1);

    if (!user) {
      return reply.code(404).send({ error: 'User not found' });
    }

    return { user };
  });
}
