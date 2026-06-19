import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import websocketPlugin, { type WebSocket } from '@fastify/websocket';
import { and, eq, isNull, asc, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { devices, messages } from '../db/schema.js';
import { getSession } from '../sessions/store.js';
import { setLocalSocket, clearLocalSocket } from '../realtime/registry.js';
import { markOnline, markOffline } from '../realtime/presence.js';

interface AuthFrame {
  type: 'auth';
  token: string;
  deviceId: string;
}

interface AckFrame {
  type: 'ack';
  messageIds: string[];
}

type ClientFrame = AuthFrame | AckFrame;

function send(socket: WebSocket, payload: unknown): void {
  try {
    socket.send(JSON.stringify(payload));
  } catch {
    // socket already closed; ignore
  }
}

async function flushBacklog(socket: WebSocket, deviceId: string): Promise<void> {
  const rows = await db
    .select()
    .from(messages)
    .where(and(eq(messages.recipientDeviceId, deviceId), isNull(messages.deliveredAt)))
    .orderBy(asc(messages.createdAt));

  for (const row of rows) {
    send(socket, { type: 'message', message: row });
  }
}

export async function wsRoutes(fastify: FastifyInstance) {
  await fastify.register(websocketPlugin);

  fastify.get('/ws', { websocket: true }, (socket /* WebSocket */, req) => {
    const wsLog = req.log.child({ wsConnectionId: randomUUID() });
    let authedDeviceId: string | null = null;
    let authTimeout: NodeJS.Timeout | null = setTimeout(() => {
      if (!authedDeviceId) {
        send(socket, { type: 'auth_error', error: 'auth timeout' });
        socket.close(4001, 'auth timeout');
      }
    }, 10_000);

    socket.on('message', async (raw: Buffer) => {
      let frame: ClientFrame;
      try {
        frame = JSON.parse(raw.toString('utf-8')) as ClientFrame;
      } catch {
        send(socket, { type: 'error', error: 'invalid JSON' });
        return;
      }

      // ----- Auth frame -----
      if (frame.type === 'auth') {
        if (authedDeviceId) {
          send(socket, { type: 'error', error: 'already authenticated' });
          return;
        }

        const session = await getSession(frame.token);
        if (!session) {
          send(socket, { type: 'auth_error', error: 'invalid session' });
          socket.close(4002, 'invalid session');
          return;
        }

        // Verify the deviceId belongs to the authenticated user.
        const [device] = await db
          .select()
          .from(devices)
          .where(and(eq(devices.id, frame.deviceId), eq(devices.userId, session.userId)))
          .limit(1);
        if (!device) {
          send(socket, { type: 'auth_error', error: 'device not owned by user' });
          socket.close(4003, 'device mismatch');
          return;
        }

        authedDeviceId = device.id;
        if (authTimeout) {
          clearTimeout(authTimeout);
          authTimeout = null;
        }

        setLocalSocket(authedDeviceId, socket);
        await markOnline(authedDeviceId);

        send(socket, { type: 'auth_ok', deviceId: authedDeviceId });

        // Flush any messages that arrived while this device was offline.
        await flushBacklog(socket, authedDeviceId);
        return;
      }

      // ----- Anything else requires auth -----
      if (!authedDeviceId) {
        send(socket, { type: 'error', error: 'not authenticated' });
        return;
      }

      if (frame.type === 'ack') {
        if (!Array.isArray(frame.messageIds) || frame.messageIds.length === 0) {
          return;
        }
        await db
          .update(messages)
          .set({ deliveredAt: new Date() })
          .where(
            and(
              inArray(messages.id, frame.messageIds),
              eq(messages.recipientDeviceId, authedDeviceId),
              isNull(messages.deliveredAt),
            ),
          );
        return;
      }

      send(socket, { type: 'error', error: 'unknown frame type' });
    });

    socket.on('close', async () => {
      if (authTimeout) {
        clearTimeout(authTimeout);
        authTimeout = null;
      }
      if (authedDeviceId) {
        clearLocalSocket(authedDeviceId, socket);
        await markOffline(authedDeviceId);
        db.update(devices)
          .set({ lastSeen: new Date() })
          .where(eq(devices.id, authedDeviceId))
          .then(() => {})
          .catch((err: unknown) => {
            wsLog.error({ err, deviceId: authedDeviceId }, 'Failed to update lastSeen on disconnect');
          });
      }
    });

    socket.on('error', (err: Error) => {
      wsLog.error({ err, authedDeviceId }, 'websocket error');
    });
  });
}
