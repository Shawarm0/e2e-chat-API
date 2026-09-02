import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { users, publicUserColumns } from '../db/schema.js';
import { createSession } from '../sessions/store.js';
import { checkRateLimit, type RateLimitResult } from '../ratelimit/limiter.js';
import { validateAndNormalizeEmail } from '../validation/email.js';
import {
  hashPassword,
  verifyPassword,
  MIN_PASSWORD_LENGTH,
  MAX_PASSWORD_LENGTH,
} from '../auth/password.js';

const credentialsSchema = z.object({
  email: z.string().min(1),
  password: z.string().min(MIN_PASSWORD_LENGTH).max(MAX_PASSWORD_LENGTH),
});

const registerSchema = credentialsSchema.extend({
  displayName: z.string().min(1).max(50).optional(),
});

// A real hash of a value nobody can supply. Verifying against it on a missing
// email keeps the failed-login timing the same whether or not the account exists.
const DUMMY_HASH =
  'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

function tooManyRequests(reply: FastifyReply, rl: RateLimitResult) {
  return reply
    .code(429)
    .header('Retry-After', String(rl.retryAfterSeconds))
    .send({ error: `Too many requests, try again in ${rl.retryAfterSeconds} seconds` });
}

export async function authRoutes(fastify: FastifyInstance) {
  // POST /auth/register — create an account and return a session for it.
  fastify.post('/auth/register', async (request, reply) => {
    const parsed = registerSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: `email and password are required; password must be ${MIN_PASSWORD_LENGTH}-${MAX_PASSWORD_LENGTH} characters`,
        issues: parsed.error.issues,
      });
    }

    const emailResult = validateAndNormalizeEmail(parsed.data.email);
    if (!emailResult.valid) {
      return reply.code(400).send({ error: emailResult.reason });
    }
    const email = emailResult.email;

    const emailRL = await checkRateLimit({
      key: `rl:auth-register:email:${email}`,
      limit: 3,
      windowSeconds: 3600,
    });
    if (!emailRL.allowed) return tooManyRequests(reply, emailRL);

    const ipRL = await checkRateLimit({
      key: `rl:auth-register:ip:${request.ip}`,
      limit: 10,
      windowSeconds: 3600,
    });
    if (!ipRL.allowed) return tooManyRequests(reply, ipRL);

    const passwordHash = await hashPassword(parsed.data.password);

    // The unique index on email is what actually decides the race between two
    // simultaneous signups; DO NOTHING lets us detect the loser without an error.
    const [user] = await db
      .insert(users)
      .values({ email, passwordHash, displayName: parsed.data.displayName })
      .onConflictDoNothing({ target: users.email })
      .returning(publicUserColumns);

    if (!user) {
      return reply.code(409).send({ error: 'An account with that email already exists' });
    }

    const sessionToken = await createSession(user.id);

    return reply.code(201).send({ user, sessionToken });
  });

  // POST /auth/login — exchange credentials for a session token.
  fastify.post('/auth/login', async (request, reply) => {
    const parsed = credentialsSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'email and password are required' });
    }

    const emailResult = validateAndNormalizeEmail(parsed.data.email);
    if (!emailResult.valid) {
      return reply.code(401).send({ error: 'Invalid email or password' });
    }
    const email = emailResult.email;

    const emailRL = await checkRateLimit({
      key: `rl:auth-login:email:${email}`,
      limit: 10,
      windowSeconds: 3600,
    });
    if (!emailRL.allowed) return tooManyRequests(reply, emailRL);

    const ipRL = await checkRateLimit({
      key: `rl:auth-login:ip:${request.ip}`,
      limit: 30,
      windowSeconds: 3600,
    });
    if (!ipRL.allowed) return tooManyRequests(reply, ipRL);

    const [row] = await db
      .select({ id: users.id, passwordHash: users.passwordHash })
      .from(users)
      .where(eq(users.email, email))
      .limit(1);

    const matches = await verifyPassword(parsed.data.password, row?.passwordHash ?? DUMMY_HASH);
    if (!row || !matches) {
      return reply.code(401).send({ error: 'Invalid email or password' });
    }

    const [user] = await db
      .select(publicUserColumns)
      .from(users)
      .where(eq(users.id, row.id))
      .limit(1);

    const sessionToken = await createSession(user.id);

    return reply.code(200).send({ user, sessionToken });
  });
}
