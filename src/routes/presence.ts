import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { users, devices } from '../db/schema.js';
import { requireAuth } from '../auth/requireAuth.js';
import { checkRateLimit } from '../ratelimit/limiter.js';
import { lookupInstance } from '../realtime/presence.js';

const paramsSchema = z.object({
  userId: z.string().uuid(),
});

export async function presenceRoutes(fastify: FastifyInstance) {
  fastify.get('/users/:userId/presence', { onRequest: [requireAuth] }, async (request, reply) => {
    const callerId = request.session!.userId;

    const parsed = paramsSchema.safeParse(request.params);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid userId', issues: parsed.error.issues });
    }
    const { userId } = parsed.data;

    const rl = await checkRateLimit({
      key: `rl:presence:${callerId}`,
      limit: 60,
      windowSeconds: 60,
    });
    if (!rl.allowed) {
      return reply
        .code(429)
        .header('Retry-After', String(rl.retryAfterSeconds))
        .send({ error: `Too many requests, try again in ${rl.retryAfterSeconds} seconds` });
    }

    const [targetUser] = await db
      .select({ presenceVisibility: users.presenceVisibility })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    if (!targetUser) {
      return reply.code(404).send({ error: 'User not found' });
    }

    if (targetUser.presenceVisibility === 'nobody') {
      return { online: false, lastSeen: null };
    }

    const userDevices = await db
      .select({ id: devices.id, lastSeen: devices.lastSeen })
      .from(devices)
      .where(eq(devices.userId, userId));

    let online = false;
    let latestLastSeen: Date | null = null;

    for (const device of userDevices) {
      const instance = await lookupInstance(device.id);
      if (instance) {
        online = true;
        break;
      }
      if (device.lastSeen && (!latestLastSeen || device.lastSeen > latestLastSeen)) {
        latestLastSeen = device.lastSeen;
      }
    }

    return {
      online,
      lastSeen: online ? null : latestLastSeen?.toISOString() ?? null,
    };
  });
}
