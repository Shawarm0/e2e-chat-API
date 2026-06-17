import { INSTANCE_ID } from './instance.js';
import { getLocalSocket } from './registry.js';
import { lookupInstance } from './presence.js';
import { publishToInstance } from './pubsub.js';

export async function deliverToDevice(
  deviceId: string,
  message: unknown,
): Promise<'delivered_local' | 'delivered_remote' | 'offline'> {
  // 1. Try local socket first.
  const localSocket = getLocalSocket(deviceId);
  if (localSocket) {
    try {
      localSocket.send(JSON.stringify({ type: 'message', message }));
      return 'delivered_local';
    } catch (err) {
      console.error('Local send failed for', deviceId, err);
    }
  }

  // 2. Otherwise check presence in Redis to find the owning instance.
  const owningInstance = await lookupInstance(deviceId);
  if (!owningInstance || owningInstance === INSTANCE_ID) {
    return 'offline';
  }

  // 3. Publish to the remote instance.
  try {
    await publishToInstance(owningInstance, { deviceId, message });
    return 'delivered_remote';
  } catch (err) {
    console.error('Cross-instance publish failed for', deviceId, err);
    return 'offline';
  }
}
