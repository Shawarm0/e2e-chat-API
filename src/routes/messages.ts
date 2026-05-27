import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, eq, isNull, inArray, asc, gt } from 'drizzle-orm';
import { db } from '../db/client.js';
import { devices, messages } from '../db/schema.js';
import { requireAuth } from '../auth/requireAuth.js';

const sendMessageSchema = z.object({
  senderDeviceId: z.string().uuid(),
  recipientDeviceId: z.string().uuid(),
  ciphertext: z.string().min(1),
  messageType: z.number().int().min(0).max(255).default(0),
});

const fetchQuerySchema = z.object({
  deviceId: z.string().uuid(),
  since: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

const ackSchema = z.object({
  deviceId: z.string().uuid(),
  messageIds: z.array(z.string().uuid()).min(1).max(500),
});

export async function messageRoutes(fastify: FastifyInstance) {
  // POST /messages — send a single ciphertext from one device to another.
  fastify.post('/messages', { onRequest: [requireAuth] }, async (request, reply) => {
    const userId = request.session!.userId;

    const parsed = sendMessageSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid request body', issues: parsed.error.issues });
    }
    const data = parsed.data;

    // The sender device must belong to the authenticated user.
    const [senderDevice] = await db
      .select()
      .from(devices)
      .where(and(eq(devices.id, data.senderDeviceId), eq(devices.userId, userId)))
      .limit(1);
    if (!senderDevice) {
      return reply.code(404).send({ error: 'Sender device not found' });
    }

    // The recipient device must exist (any user).
    const [recipientDevice] = await db
      .select()
      .from(devices)
      .where(eq(devices.id, data.recipientDeviceId))
      .limit(1);
    if (!recipientDevice) {
      return reply.code(404).send({ error: 'Recipient device not found' });
    }

    const [message] = await db
      .insert(messages)
      .values({
        senderDeviceId: data.senderDeviceId,
        recipientDeviceId: data.recipientDeviceId,
        ciphertext: data.ciphertext,
        messageType: data.messageType,
      })
      .returning();

    return reply.code(201).send({ message });
  });

  // GET /messages?deviceId=...&since=...&limit=... — fetch undelivered messages.
  fastify.get('/messages', { onRequest: [requireAuth] }, async (request, reply) => {
    const userId = request.session!.userId;

    const parsed = fetchQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid query', issues: parsed.error.issues });
    }
    const { deviceId, since, limit } = parsed.data;

    // The device must belong to the authenticated user.
    const [device] = await db
      .select()
      .from(devices)
      .where(and(eq(devices.id, deviceId), eq(devices.userId, userId)))
      .limit(1);
    if (!device) {
      return reply.code(404).send({ error: 'Device not found' });
    }

    const conditions = [eq(messages.recipientDeviceId, deviceId), isNull(messages.deliveredAt)];
    if (since) {
      conditions.push(gt(messages.id, since));
    }

    const rows = await db
      .select()
      .from(messages)
      .where(and(...conditions))
      .orderBy(asc(messages.createdAt))
      .limit(limit);

    return reply.code(200).send({ messages: rows });
  });

  // POST /messages/ack — acknowledge a batch of messages as delivered.
  fastify.post('/messages/ack', { onRequest: [requireAuth] }, async (request, reply) => {
    const userId = request.session!.userId;

    const parsed = ackSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid request body', issues: parsed.error.issues });
    }
    const { deviceId, messageIds } = parsed.data;

    // The device must belong to the authenticated user.
    const [device] = await db
      .select()
      .from(devices)
      .where(and(eq(devices.id, deviceId), eq(devices.userId, userId)))
      .limit(1);
    if (!device) {
      return reply.code(404).send({ error: 'Device not found' });
    }

    // Only flip delivered_at for messages actually addressed to this device.
    // Critical: prevents Alice from ack-ing messages addressed to Bob.
    const updated = await db
      .update(messages)
      .set({ deliveredAt: new Date() })
      .where(
        and(
          inArray(messages.id, messageIds),
          eq(messages.recipientDeviceId, deviceId),
          isNull(messages.deliveredAt),
        ),
      )
      .returning({ id: messages.id });

    return reply.code(200).send({ acked: updated.length });
  });
}
