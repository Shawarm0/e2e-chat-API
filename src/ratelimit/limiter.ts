import { redis } from '../redis/client.js';

export interface RateLimitConfig {
  key: string;
  limit: number;
  windowSeconds: number;
}

export interface RateLimitResult {
  allowed: boolean;
  retryAfterSeconds: number;
}

const LUA_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
local ttl = redis.call('PTTL', KEYS[1])
return {count, ttl}
`;

export async function checkRateLimit(config: RateLimitConfig): Promise<RateLimitResult> {
  const result = (await redis.eval(
    LUA_SCRIPT,
    1,
    config.key,
    config.windowSeconds,
  )) as [number, number];

  const count = result[0];
  const pttl = result[1];
  const retryAfterSeconds = Math.max(1, Math.ceil(pttl / 1000));

  if (count > config.limit) {
    return { allowed: false, retryAfterSeconds };
  }

  return { allowed: true, retryAfterSeconds: 0 };
}
