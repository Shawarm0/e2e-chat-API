import Fastify from 'fastify';
import { healthRoutes } from './routes/health.js';
import { authRoutes } from './routes/auth.js';
import { meRoutes } from './routes/me.js';

const fastify = Fastify({
    logger: true,
})

await fastify.register(healthRoutes);
await fastify.register(authRoutes);
await fastify.register(meRoutes);

const port = Number(process.env.PORT) || 3000;
const host = '0.0.0.0';

try {
    await fastify.listen({ port, host });
} catch (err) {
    fastify.log.error(err);
    process.exit(1);
}

