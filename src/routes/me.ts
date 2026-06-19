import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { users } from '../db/schema.js';
import { requireAuth } from '../auth/requireAuth.js';

const updateMeSchema = z.object({
  displayName: z.string().min(1).max(50).optional(),
  presenceVisibility: z.enum(['everyone', 'nobody']).optional(),
}).refine(data => data.displayName !== undefined || data.presenceVisibility !== undefined, {
  message: 'At least one field must be provided',
});

export async function meRoutes(fastify: FastifyInstance) {
  fastify.get('/me', { onRequest: [requireAuth] }, async (request, reply) => {
    const session = request.session!;

    const [user] = await db.select().from(users).where(eq(users.id, session.userId)).limit(1);

    if (!user) {
      return reply.code(404).send({ error: 'User not found' });
    }

    return { user };
  });

  fastify.patch('/me', { onRequest: [requireAuth] }, async (request, reply) => {
    const session = request.session!;

    const parsed = updateMeSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid request body', issues: parsed.error.issues });
    }

    const updates: Partial<{ displayName: string; presenceVisibility: string }> = {};
    if (parsed.data.displayName !== undefined) updates.displayName = parsed.data.displayName;
    if (parsed.data.presenceVisibility !== undefined) updates.presenceVisibility = parsed.data.presenceVisibility;

    const [user] = await db
      .update(users)
      .set(updates)
      .where(eq(users.id, session.userId))
      .returning();

    if (!user) {
      return reply.code(404).send({ error: 'User not found' });
    }

    return { user };
  });
}
