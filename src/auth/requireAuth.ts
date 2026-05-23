import type { FastifyRequest, FastifyReply } from 'fastify';
import { getSession, type SessionData } from '../sessions/store.js';

// Augment Fastify's request type so request.session is typed.
declare module 'fastify' {
    interface FastifyRequest {
        session?: SessionData;
    }
}

export async function requireAuth(request: FastifyRequest, reply: FastifyReply) {
    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return reply.code(401).send({ error: 'Missing or malformed Authorization header' });
    }

    const token = authHeader.slice('Bearer '.length).trim();
    if (!token) {
        return reply.code(401).send({ error: 'Empty token' });
    }

    const session = await getSession(token);
    if (!session) {
        return reply.code(401).send({ error: 'Invalid or expired session' });
    }

    request.session = session;
}
