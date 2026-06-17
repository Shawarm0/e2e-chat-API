import type { WebSocket } from '@fastify/websocket';

const localSockets = new Map<string, WebSocket>();

export function setLocalSocket(deviceId: string, socket: WebSocket): void {
  // If a previous socket exists for this device (e.g. reconnect), close it.
  const existing = localSockets.get(deviceId);
  if (existing && existing !== socket) {
    try {
      existing.close(4000, 'replaced by newer connection');
    } catch {
      // ignore
    }
  }
  localSockets.set(deviceId, socket);
}

export function clearLocalSocket(deviceId: string, socket: WebSocket): void {
  // Only clear if the registered socket is still the one we're closing.
  // (Prevents a reconnect race from wiping the new socket.)
  if (localSockets.get(deviceId) === socket) {
    localSockets.delete(deviceId);
  }
}

export function getLocalSocket(deviceId: string): WebSocket | undefined {
  return localSockets.get(deviceId);
}
