import { randomBytes } from "node:crypto";
import { redis } from "../redis/client.js";

const SESSION_PREFIX = 'session';
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;

export interface SessionData {
    userId: string;
    deviceId?: string;
    createdAt: number;
}


function sessionKey(token: string): string {
    return `${SESSION_PREFIX}${token}`;
}

function generateToken(): string {
    return randomBytes(32).toString('base64url');
}


export async function createSession(userId: string, deviceId?: string): Promise<string> {
    const token = generateToken();
    const data: SessionData = {
        userId,
        deviceId,
        createdAt: Date.now(),
    };
    await redis.set(sessionKey(token), JSON.stringify(data), 'EX', SESSION_TTL_SECONDS);
    return token;
}



export async function getSession(token: string): Promise<SessionData | null> {
    const raw = await redis.get(sessionKey(token));
    if (!raw) return null;
    try {
        return JSON.parse(raw) as SessionData;
    } catch {
        return null;
    }
}

export async function revokeSession(token: string): Promise<void> {
    await redis.del(sessionKey(token));
}
