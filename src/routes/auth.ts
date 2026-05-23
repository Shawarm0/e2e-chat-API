import type { FastifyInstance } from 'fastify';
import { sendVerificationCode, checkVerificationCode } from '../twilio/client.js';
import { db } from '../db/client.js';
import { users } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { createSession } from '../sessions/store.js';

export async function authRoutes(fastify: FastifyInstance) {
  fastify.post<{
    Body: { phoneNumber: string };
  }>('/auth/request-code', async (request, reply) => {
    const { phoneNumber } = request.body;

    if (!phoneNumber || !phoneNumber.startsWith('+')) {
      return reply.code(400).send({
        error: 'phoneNumber is required and must be in E.164 format (e.g.+4477700090)',
      });
    }

    try {
      const verification = await sendVerificationCode(phoneNumber);
      return reply.code(200).send({ status: verification.status });
    } catch (err) {
      fastify.log.error({ err, phoneNumber }, 'Failed to send verification code');
      return reply.code(500).send({ error: 'Failed to send verification code' });
    }
  });

  fastify.post<{
    Body: { phoneNumber: string; code: string };
  }>('/auth/verify-code', async (request, reply) => {
    const { phoneNumber, code } = request.body;

    if (!phoneNumber || !code) {
      return reply.code(400).send({ error: 'phoneNumber and code are required' });
    }

    let verification;
    try {
      verification = await checkVerificationCode(phoneNumber, code);
    } catch (err) {
      fastify.log.error({ err, phoneNumber }, 'Failed to check verification code');
      return reply.code(500).send({ error: 'Failed to check verification code' });
    }

    if (verification.status !== 'approved') {
      return reply.code(401).send({ error: 'Invalid code' });
    }

    const [user] = await db
      .insert(users)
      .values({ phoneNumber })
      .onConflictDoUpdate({
        target: users.phoneNumber,
        set: { phoneNumber },
      })
      .returning();

    const sessionToken = await createSession(user.id);

    return reply.code(200).send({ user, sessionToken });
  });
}
