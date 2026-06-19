import { inArray } from 'drizzle-orm';
import { redis } from '../redis/client.js';
import { db } from '../db/client.js';
import { devices } from '../db/schema.js';
import { INSTANCE_ID } from './instance.js';
import { logger } from '../logger.js';

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

export async function bulkUpdateLastSeen(deviceIds: string[]): Promise<void> {
  if (deviceIds.length === 0) return;
  await db
    .update(devices)
    .set({ lastSeen: new Date() })
    .where(inArray(devices.id, deviceIds));
}

export function startPresenceRefresher(getActiveDeviceIds: () => Iterable<string>): NodeJS.Timeout {
  return setInterval(async () => {
    const activeIds = Array.from(getActiveDeviceIds());
    for (const deviceId of activeIds) {
      try {
        await redis.set(presenceKey(deviceId), INSTANCE_ID, 'EX', PRESENCE_TTL_SECONDS);
      } catch (err) {
        logger.error({ err, deviceId }, 'Failed to refresh presence');
      }
    }
    try {
      await bulkUpdateLastSeen(activeIds);
    } catch (err) {
      logger.error({ err }, 'Failed bulk lastSeen update');
    }
  }, PRESENCE_REFRESH_INTERVAL_MS);
}
