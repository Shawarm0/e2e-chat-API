import Fastify from 'fastify';

const fastify = Fastify({
    logger: true,
})

fastify.get('/health', async () => {
    return { ok: true }
});

fastify.get('/debug/env', async () => {
    return {
        hasDatabaseUrl: !!process.env.DATABASE_URL,
        hasRedisUrl: !!process.env.REDIS_URL,
        nodeEnv: process.env.NODE_ENV ?? 'unset',
    }
})



const port = Number(process.env.PORT) || 3000;
const host = '0.0.0.0';

try {
    await fastify.listen({ port, host });
} catch (err) {
    fastify.log.error(err);
    process.exit(1);
}

