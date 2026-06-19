import Fastify from 'fastify';
import { healthRoutes } from './routes/health.js';
import { authRoutes } from './routes/auth.js';
import { meRoutes } from './routes/me.js';
import { deviceRoutes } from './routes/devices.js';
import { keyRoutes } from './routes/keys.js';
import { messageRoutes } from './routes/messages.js';
import { wsRoutes } from './routes/ws.js';
import { userRoutes } from './routes/users.js';
import { presenceRoutes } from './routes/presence.js';
import { INSTANCE_ID } from './realtime/instance.js';
import { initPubSub, closePubSub } from './realtime/pubsub.js';
import { startPresenceRefresher, markOffline } from './realtime/presence.js';
import { getLocalDeviceIds, getAllLocalSockets } from './realtime/registry.js';
import { closeDb } from './db/client.js';
import { redis } from './redis/client.js';

const fastify = Fastify({
  logger: true,
});

// Register all routes.
await fastify.register(healthRoutes);
await fastify.register(authRoutes);
await fastify.register(meRoutes);
await fastify.register(deviceRoutes);
await fastify.register(keyRoutes);
await fastify.register(messageRoutes);
await fastify.register(wsRoutes);
await fastify.register(userRoutes);
await fastify.register(presenceRoutes);

const port = Number(process.env.PORT) || 3000;
const host = '0.0.0.0';

let presenceInterval: NodeJS.Timeout;

try {
  await initPubSub();
  presenceInterval = startPresenceRefresher(getLocalDeviceIds);
  fastify.log.info({ instanceId: INSTANCE_ID }, 'instance booted');
  await fastify.listen({ port, host });
} catch (err) {
  fastify.log.error(err);
  process.exit(1);
}

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  fastify.log.info({ signal }, 'Shutdown signal received');

  const forceExit = setTimeout(() => {
    fastify.log.error('Graceful shutdown timed out, forcing exit');
    process.exit(1);
  }, 10_000);
  forceExit.unref();

  try {
    await fastify.close();

    const deviceIdsToOffline = Array.from(getLocalDeviceIds());

    for (const [, socket] of getAllLocalSockets()) {
      try {
        socket.close(1001, 'server shutting down');
      } catch {
        // already closed
      }
    }

    clearInterval(presenceInterval);

    for (const deviceId of deviceIdsToOffline) {
      await markOffline(deviceId);
    }

    await closePubSub();
    redis.disconnect();
    await closeDb();

    fastify.log.info('Graceful shutdown complete');
    clearTimeout(forceExit);
    process.exit(0);
  } catch (err) {
    fastify.log.error({ err }, 'Error during shutdown');
    process.exit(1);
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
