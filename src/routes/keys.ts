import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq, and, desc, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { devices, signedPreKeys, oneTimePreKeys } from '../db/schema.js';
import { requireAuth } from '../auth/requireAuth.js';

const paramsSchema = z.object({
  userId: z.string().uuid(),
});

export async function keyRoutes(fastify: FastifyInstance) {
  fastify.get('/keys/:userId', { onRequest: [requireAuth] }, async (request, reply) => {
    const parseResult = paramsSchema.safeParse(request.params);
    if (!parseResult.success) {
      return reply.code(400).send({
        error: 'Invalid userId',
        issues: parseResult.error.issues,
      });
    }

    const { userId } = parseResult.data;

    // Find the most recently registered device for this user.
    const [device] = await db
      .select()
      .from(devices)
      .where(eq(devices.userId, userId))
      .orderBy(desc(devices.createdAt))
      .limit(1);

    if (!device) {
      return reply.code(404).send({ error: 'No devices registered for this user' });
    }

    // Find the most recent signed prekey for that device.
    const [signedPreKey] = await db
      .select()
      .from(signedPreKeys)
      .where(eq(signedPreKeys.deviceId, device.id))
      .orderBy(desc(signedPreKeys.createdAt))
      .limit(1);

    if (!signedPreKey) {
      return reply.code(500).send({ error: 'Device has no signed prekey' });
    }

    // Atomically claim one unused one-time prekey. May return nothing if pool empty.
    const claimed = await db.execute(sql`
      UPDATE one_time_prekeys
      SET used = true, used_at = now()
      WHERE id = (
        SELECT id FROM one_time_prekeys
        WHERE device_id = ${device.id} AND used = false
        ORDER BY key_id ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      RETURNING key_id, public_key
    `);

    const oneTimePreKey = claimed[0]
      ? { keyId: claimed[0].key_id as number, publicKey: claimed[0].public_key as string }
      : null;

    return reply.code(200).send({
      deviceId: device.id,
      registrationId: device.registrationId,
      identityKey: device.identityKeyPublic,
      signedPreKey: {
        keyId: signedPreKey.keyId,
        publicKey: signedPreKey.publicKey,
        signature: signedPreKey.signature,
      },
      preKey: oneTimePreKey,
    });
  });
}
