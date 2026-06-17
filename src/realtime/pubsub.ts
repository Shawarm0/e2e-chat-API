import { Redis } from 'ioredis';
import { INSTANCE_ID } from './instance.js';
import { getLocalSocket } from './registry.js';

const PUBSUB_PREFIX = 'instance:';

function channelFor(instanceId: string): string {
  return `${PUBSUB_PREFIX}${instanceId}`;
}

const redisUrl = process.env.REDIS_URL;
if (!redisUrl) {
  throw new Error('REDIS_URL is not set');
}

// Pub/sub clients are separate connections to Redis. A subscribed client
// can't run normal commands, so we use one client per role.
const subscriber = new Redis(redisUrl, { maxRetriesPerRequest: 3 });
const publisher = new Redis(redisUrl, { maxRetriesPerRequest: 3 });

subscriber.on('error', (err: Error) => {
  console.error('Redis subscriber error:', err);
});


publisher.on('error', (err: Error) => {
  console.error('Redis publisher error:', err);
});

subscriber.on('message', (_channel: string, raw: string) => {
  // ...
});

interface DeliveryPayload {
  deviceId: string;
  message: unknown;
}

let initialised = false;

export async function initPubSub(): Promise<void> {
  if (initialised) return;
  initialised = true;

  await subscriber.subscribe(channelFor(INSTANCE_ID));

  subscriber.on('message', (_channel, raw) => {
    let payload: DeliveryPayload;
    try {
      payload = JSON.parse(raw) as DeliveryPayload;
    } catch {
      return;
    }

    const socket = getLocalSocket(payload.deviceId);
    if (!socket) return; // device disconnected since presence lookup

    try {
      socket.send(JSON.stringify({ type: 'message', message: payload.message }));
    } catch (err) {
      console.error('Failed to deliver message to local socket', err);
    }
  });
}

export async function publishToInstance(
  instanceId: string,
  payload: DeliveryPayload,
): Promise<void> {
  await publisher.publish(channelFor(instanceId), JSON.stringify(payload));
}
