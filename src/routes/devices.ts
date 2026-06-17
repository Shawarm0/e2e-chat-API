import type { FastifyInstance } from "fastify";
import { z } from 'zod';
import { db } from "../db/client.js";
import { devices, signedPreKeys, oneTimePreKeys } from '../db/schema.js'
import { requireAuth } from "../auth/requireAuth.js";
import { eq, and } from 'drizzle-orm';
import { checkRateLimit } from '../ratelimit/limiter.js';


const registerDeviceSchema = z.object({
  deviceName: z.string().max(100).optional(),
  registrationId: z.number().int().min(0).max(16383),
  identityKeyPublic: z.string().min(1).max(256),
  signedPreKey: z.object({
    keyId: z.number().int().min(0),
    publicKey: z.string().min(1).max(256),
    signature: z.string().min(1).max(512),
  }),
  oneTimePreKeys: z
    .array(
      z.object({
        keyId: z.number().int().min(0),
        publicKey: z.string().min(1).max(256),
      })
    )
    .min(1).max(200),
});

const topupSchema = z.object({
  signedPreKey: z.object({
    keyId: z.number().int().min(0),
    publicKey: z.string().min(1).max(256),
    signature: z.string().min(1).max(512),
  })
    .optional(),
  oneTimePreKeys: z
    .array(
      z.object({
        keyId: z.number().int().min(0),
        publicKey: z.string().min(1).max(256),
      })
    )
    .min(1).max(200),
});

const deviceParamsSchema = z.object({
  deviceId: z.string().uuid(),
});



export async function deviceRoutes(fastify: FastifyInstance) {
  fastify.post('/devices', { onRequest: [requireAuth] }, async (request, reply) => {
    const userId = request.session!.userId;

    const rl = await checkRateLimit({
      key: `rl:dev:register:${userId}`,
      limit: 5,
      windowSeconds: 3600,
    });
    if (!rl.allowed) {
      return reply
        .code(429)
        .header('Retry-After', String(rl.retryAfterSeconds))
        .send({ error: `Too many requests, try again in ${rl.retryAfterSeconds} seconds` });
    }

    const parseResult = registerDeviceSchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.code(400).send({
        error: 'Invalid request body',
        issues: parseResult.error.issues,
      });
    }

    const data = parseResult.data;

    const device = await db.transaction(async (tx) => {

      const [newDevice] = await tx
        .insert(devices)
        .values({
          userId,
          deviceName: data.deviceName,
          registrationId: data.registrationId,
          identityKeyPublic: data.identityKeyPublic,
        })
        .returning();

      await tx.insert(signedPreKeys).values({
        deviceId: newDevice.id,
        keyId: data.signedPreKey.keyId,
        publicKey: data.signedPreKey.publicKey,
        signature: data.signedPreKey.signature,
      });
      await tx.insert(oneTimePreKeys).values(
        data.oneTimePreKeys.map((pk) => ({
          deviceId: newDevice.id,
          keyId: pk.keyId,
          publicKey: pk.publicKey,
        })),
      );

      return newDevice;
    });

    return reply.code(201).send({ device });
  })

  fastify.post(
    '/devices/:deviceId/prekeys',
    { onRequest: [requireAuth] },
    async (request, reply) => {
      const userId = request.session!.userId;

      const paramsParse = deviceParamsSchema.safeParse(request.params);
      if (!paramsParse.success) {
        return reply.code(400).send({
          error: 'Invalid deviceId',
          issues: paramsParse.error.issues,
        });
      }

      const bodyParse = topupSchema.safeParse(request.body);
      if (!bodyParse.success) {
        return reply.code(400).send({
          error: 'Invalid request body',
          issues: bodyParse.error.issues,
        });
      }

      const { deviceId } = paramsParse.data;
      const data = bodyParse.data;

      const rl = await checkRateLimit({
        key: `rl:dev:prekeys:${deviceId}`,
        limit: 30,
        windowSeconds: 3600,
      });
      if (!rl.allowed) {
        return reply
          .code(429)
          .header('Retry-After', String(rl.retryAfterSeconds))
          .send({ error: `Too many requests, try again in ${rl.retryAfterSeconds} seconds` });
      }

      // Authorization: the device must belong to the authenticated user.
      const [device] = await db
        .select()
        .from(devices)
        .where(and(eq(devices.id, deviceId), eq(devices.userId, userId)))
        .limit(1);

      if (!device) {
        return reply.code(404).send({ error: 'Device not found' });
      }

      await db.transaction(async (tx) => {
        if (data.signedPreKey) {
          await tx.insert(signedPreKeys).values({
            deviceId,
            keyId: data.signedPreKey.keyId,
            publicKey: data.signedPreKey.publicKey,
            signature: data.signedPreKey.signature,
          });
        }

        await tx.insert(oneTimePreKeys).values(
          data.oneTimePreKeys.map((pk) => ({
            deviceId,
            keyId: pk.keyId,
            publicKey: pk.publicKey,
          })),
        );
      });

      return reply.code(204).send();
    },
  );
}
