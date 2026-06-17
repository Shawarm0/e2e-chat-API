import type { FastifyInstance } from 'fastify';
import { sendVerificationCode, checkVerificationCode } from '../twilio/client.js';
import { db } from '../db/client.js';
import { users } from '../db/schema.js';
import { createSession } from '../sessions/store.js';
import { checkRateLimit } from '../ratelimit/limiter.js';
import { validateAndNormalizePhone } from '../validation/phone.js';

export async function authRoutes(fastify: FastifyInstance) {
  fastify.post<{
    Body: { phoneNumber: string };
  }>('/auth/request-code', async (request, reply) => {
    const { phoneNumber: rawPhone } = request.body;

    if (!rawPhone) {
      return reply.code(400).send({ error: 'phoneNumber is required' });
    }

    const phoneResult = validateAndNormalizePhone(rawPhone);
    if (!phoneResult.valid) {
      return reply.code(400).send({ error: phoneResult.reason });
    }
    const phoneNumber = phoneResult.e164;

    const phoneRL = await checkRateLimit({
      key: `rl:auth-req:phone:${phoneNumber}`,
      limit: 3,
      windowSeconds: 3600,
    });
    if (!phoneRL.allowed) {
      return reply
        .code(429)
        .header('Retry-After', String(phoneRL.retryAfterSeconds))
        .send({ error: `Too many requests, try again in ${phoneRL.retryAfterSeconds} seconds` });
    }

    const ipRL = await checkRateLimit({
      key: `rl:auth-req:ip:${request.ip}`,
      limit: 10,
      windowSeconds: 3600,
    });
    if (!ipRL.allowed) {
      return reply
        .code(429)
        .header('Retry-After', String(ipRL.retryAfterSeconds))
        .send({ error: `Too many requests, try again in ${ipRL.retryAfterSeconds} seconds` });
    }

    try {
      const verification = await sendVerificationCode(phoneNumber);
      return reply.code(200).send({ status: verification.status });
    } catch (err) {
      request.log.error({ err, phoneNumber }, 'Failed to send verification code');
      return reply.code(500).send({ error: 'Failed to send verification code' });
    }
  });

  fastify.post<{
    Body: { phoneNumber: string; code: string };
  }>('/auth/verify-code', async (request, reply) => {
    const { phoneNumber: rawPhone, code } = request.body;

    if (!rawPhone || !code) {
      return reply.code(400).send({ error: 'phoneNumber and code are required' });
    }

    const phoneResult = validateAndNormalizePhone(rawPhone);
    if (!phoneResult.valid) {
      return reply.code(400).send({ error: phoneResult.reason });
    }
    const phoneNumber = phoneResult.e164;

    const phoneRL = await checkRateLimit({
      key: `rl:auth-verify:phone:${phoneNumber}`,
      limit: 10,
      windowSeconds: 3600,
    });
    if (!phoneRL.allowed) {
      return reply
        .code(429)
        .header('Retry-After', String(phoneRL.retryAfterSeconds))
        .send({ error: `Too many requests, try again in ${phoneRL.retryAfterSeconds} seconds` });
    }

    const ipRL = await checkRateLimit({
      key: `rl:auth-verify:ip:${request.ip}`,
      limit: 30,
      windowSeconds: 3600,
    });
    if (!ipRL.allowed) {
      return reply
        .code(429)
        .header('Retry-After', String(ipRL.retryAfterSeconds))
        .send({ error: `Too many requests, try again in ${ipRL.retryAfterSeconds} seconds` });
    }

    let verification;
    try {
      verification = await checkVerificationCode(phoneNumber, code);
    } catch (err) {
      request.log.error({ err, phoneNumber }, 'Failed to check verification code');
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
