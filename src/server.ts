import Fastify from 'fastify';
import { healthRoutes } from './routes/health.js';

const fastify = Fastify({
    logger: true,
})

await fastify.register(healthRoutes);

const port = Number(process.env.PORT) || 3000;
const host = '0.0.0.0';

try {
    await fastify.listen({ port, host });
} catch (err) {
    fastify.log.error(err);
    process.exit(1);
}

