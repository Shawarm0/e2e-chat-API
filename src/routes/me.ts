import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { users } from '../db/schema.js';
import { requireAuth } from '../auth/requireAuth.js';

export async function meRoutes(fastify: FastifyInstance) {
  fastify.get('/me', { onRequest: [requireAuth] }, async (request, reply) => {
    const session = request.session!;

    const [user] = await db.select().from(users).where(eq(users.id, session.userId)).limit(1);

    if (!user) {
      return reply.code(404).send({ error: 'User not found' });
    }

    return { user };
  });
}
