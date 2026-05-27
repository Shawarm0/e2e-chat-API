import type { FastifyInstance } from "fastify";
import { z } from 'zod';
import { db } from "../db/client.js";
import { devices, signedPreKeys, oneTimePreKeys } from '../db/schema.js'
import { requireAuth } from "../auth/requireAuth.js";
import { parse } from "node:path";

const registerDeviceSchema = z.object({
  deviceName: z.string().max(100).optional(),
  registrationId: z.number().int().min(0).max(16383),
  identityKeyPublic: z.string().min(1),
  signedPreKey: z.object({
    keyId: z.number().int().min(0),
    publicKey: z.string().min(1),
    signature: z.string().min(1),
  }),
  oneTimePreKeys: z
    .array(
      z.object({
        keyId: z.number().int().min(0),
        publicKey: z.string().min(1),
      })
    )
    .min(1).max(200),
})

export async function deviceRoutes(fastify: FastifyInstance) {
  fastify.post('/devices', { onRequest: [requireAuth] }, async (request, reply) => {
    const userId = request.session!.userId;

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









  })




}

