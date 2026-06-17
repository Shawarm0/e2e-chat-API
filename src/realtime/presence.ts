import { redis } from '../redis/client.js';
import { INSTANCE_ID } from './instance.js';

const PRESENCE_TTL_SECONDS = 60;
const PRESENCE_REFRESH_INTERVAL_MS = 30_000;

function presenceKey(deviceId: string): string {
  return `presence:device:${deviceId}`;
}

export async function markOnline(deviceId: string): Promise<void> {
  await redis.set(presenceKey(deviceId), INSTANCE_ID, 'EX', PRESENCE_TTL_SECONDS);
}

export async function markOffline(deviceId: string): Promise<void> {
  // Only delete if we're the owning instance — prevents a stale shutdown
  // wiping a presence key for a fresh connection on a different instance.
  const current = await redis.get(presenceKey(deviceId));
  if (current === INSTANCE_ID) {
    await redis.del(presenceKey(deviceId));
  }
}

export async function lookupInstance(deviceId: string): Promise<string | null> {
  return redis.get(presenceKey(deviceId));
}

export function startPresenceRefresher(getActiveDeviceIds: () => Iterable<string>): NodeJS.Timeout {
  return setInterval(async () => {
    for (const deviceId of getActiveDeviceIds()) {
      try {
        await redis.set(presenceKey(deviceId), INSTANCE_ID, 'EX', PRESENCE_TTL_SECONDS);
      } catch (err) {
        console.error('Failed to refresh presence for', deviceId, err);
      }
    }
  }, PRESENCE_REFRESH_INTERVAL_MS);
}
