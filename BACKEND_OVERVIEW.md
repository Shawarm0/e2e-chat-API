# e2e-chat-API — Backend Overview

A tour of what exists, where it lives, and which code runs when.

---

## Current state

A Fastify backend in TypeScript, deployed to Railway. Supports email and password authentication with scrypt-hashed passwords, session tokens stored in Redis, device registration with Signal-Protocol-shaped cryptographic keys, prekey bundle distribution, message storage and delivery, and a realtime WebSocket layer that pushes messages to connected devices.

The server never sees plaintext. It stores ciphertext blobs, hands out public keys, and routes opaque messages between device "mailboxes." All encryption work happens on clients (when there are real clients).

### Tech stack

- **Fastify** — HTTP web framework.
- **@fastify/websocket** — WebSocket plugin layered on top.
- **Drizzle ORM** + **postgres** — typed database access against PostgreSQL.
- **ioredis** — Redis client for sessions, presence, and pub/sub.
- **node:crypto scrypt** — password hashing. No third-party dependency.
- **Zod** — request validation.
- **TypeScript** + **tsx** — types in dev, compiled JS for production.

### Project structure

```
src/
├── server.ts                 entry point — boots Fastify, registers routes, starts realtime
├── auth/
│   ├── requireAuth.ts        hook that validates session tokens on protected REST routes
│   └── password.ts           scrypt hashing and constant-time verification
├── db/
│   ├── client.ts             opens the Postgres connection
│   └── schema.ts             users, devices, prekeys, signed_prekeys, messages
├── redis/
│   └── client.ts             opens the main Redis connection (commands)
├── realtime/
│   ├── instance.ts           per-process random UUID (INSTANCE_ID)
│   ├── registry.ts           in-process Map<deviceId, WebSocket>
│   ├── presence.ts           Redis presence keys + TTL refresher
│   ├── pubsub.ts             cross-instance message routing via Redis pub/sub
│   └── delivery.ts           "deliver to device wherever it is" composed helper
├── routes/
│   ├── health.ts             GET /health
│   ├── auth.ts               POST /auth/register, POST /auth/login
│   ├── me.ts                 GET /me, PATCH /me (protected)
│   ├── devices.ts            POST /devices, POST /devices/:deviceId/prekeys
│   ├── keys.ts               GET /keys/:userId (consumes a one-time prekey)
│   ├── messages.ts           POST /messages, GET /messages, POST /messages/ack
│   ├── presence.ts           GET /users/:userId/presence
│   └── ws.ts                 GET /ws (WebSocket: auth frame, message frames, ack frames)
├── sessions/
│   └── store.ts              createSession, getSession, revokeSession (Redis-backed)
└── validation/
    └── email.ts              validates and lower-cases addresses before storage
```

### Environment variables

Loaded from `.env` locally (gitignored) and set in the Railway dashboard in production.

- `DATABASE_URL` — Postgres connection string.
- `REDIS_URL` — Redis connection string.
- `PORT` — set by Railway in production; defaults to 3000 locally.

Every module that needs these reads `process.env` at startup and crashes immediately if anything's missing. Fail-fast on misconfiguration.

---

## How startup works

When the server process boots:

1. **`src/server.ts` runs.** It imports route modules and realtime helpers. Each import triggers module initialisation, opening the Postgres pool, Redis connection, and pub/sub connections.
2. **`INSTANCE_ID` is generated** — a random UUID unique to this process. Used as the value in presence keys.
3. **Routes are registered** via `fastify.register(...)`. Each `routes/*.ts` module attaches its handlers.
4. **`initPubSub()` runs.** Subscribes the process to its own `instance:<id>` Redis channel. Other instances will publish there to route messages across processes.
5. **`startPresenceRefresher(...)` runs.** Sets up a recurring task that re-writes the TTL on every locally-connected device's presence key every 30 seconds.
6. **`fastify.listen(...)`** opens the HTTP socket. Both REST and WebSocket connections come in here; Fastify handles the upgrade for `/ws` automatically.

After this, the process sits in the Node event loop. Connections to Postgres and Redis (one for normal commands, two more for pub/sub) stay open in the background.

---

## User flows

### Flow 1: creating an account

Client sends: `POST /auth/register` with body `{ "email", "password", "displayName"? }`.

1. Handler in `src/routes/auth.ts` validates the body (Zod). Passwords are 8–200 characters.
2. The email is trimmed and lower-cased by `validateAndNormalizeEmail`, so addresses are unique case-insensitively.
3. Rate limits: 3 registrations per hour per email, 10 per hour per IP.
4. `hashPassword` derives a scrypt hash (N=16384, r=8, p=1) with a fresh 16-byte salt. The stored string is `scrypt$N$r$p$salt$hash`, so the parameters travel with the hash and can be raised later without invalidating old rows.
5. `INSERT ... ON CONFLICT DO NOTHING` on the unique email index. No row back means the address is taken → 409.
6. `createSession(userId)` generates a 32-byte random token, stores it in Redis as `session:<token> → JSON` with 30-day TTL.
7. Returns `{ user, sessionToken }` with HTTP 201. `password_hash` is never in a response body — every route selects `publicUserColumns`.

### Flow 2: signing in

Client sends: `POST /auth/login` with body `{ "email", "password" }`.

1. Handler validates and normalises the email. Rate limits: 10 attempts per hour per email, 30 per hour per IP.
2. Looks up the user's `password_hash` by email.
3. `verifyPassword` re-derives the hash using the parameters embedded in the stored string and compares with `timingSafeEqual`. If the email is unknown it verifies against a dummy hash anyway, so a missing account and a wrong password take the same time and return the same 401.
4. Success → `createSession(userId)`, returns `{ user, sessionToken }`.

Accounts that predate this flow (created by SMS verification) were backfilled by migration `0004` with a placeholder `@legacy.invalid` address and a sentinel password hash that cannot verify. They own their old devices and messages but cannot sign in; there is no password reset flow yet.

### Flow 3: registering a device

Client (authenticated) sends: `POST /devices` with body containing `registrationId`, `identityKeyPublic`, `signedPreKey`, and an array of `oneTimePreKeys`.

1. `requireAuth` hook validates the Bearer token.
2. Handler in `src/routes/devices.ts` validates body (Zod).
3. Opens a Postgres transaction.
4. INSERT into `devices`. INSERT one signed prekey. INSERT all one-time prekeys.
5. If any step fails, the whole thing rolls back — no half-registered devices.
6. Returns the new device row with HTTP 201.

### Flow 4: fetching a prekey bundle

Client (authenticated) sends: `GET /keys/:userId`.

1. `requireAuth` validates the Bearer token.
2. Handler in `src/routes/keys.ts` finds the most recently registered device for the target user.
3. Finds the most recent signed prekey for that device.
4. Runs an atomic claim of one unused one-time prekey:
   ```sql
   UPDATE one_time_prekeys
   SET used = true, used_at = now()
   WHERE id = (SELECT id FROM one_time_prekeys
               WHERE device_id = $1 AND used = false
               ORDER BY key_id ASC LIMIT 1
               FOR UPDATE SKIP LOCKED)
   RETURNING *
   ```
   `SKIP LOCKED` means concurrent requests grab different prekeys instead of waiting on each other.
5. Returns `{ deviceId, registrationId, identityKey, signedPreKey, preKey }`. `preKey` may be `null` if the pool is exhausted — the Signal handshake still works, just with slightly weaker forward secrecy.

### Flow 5: sending a message (REST)

Client (authenticated) sends: `POST /messages` with `{ senderDeviceId, recipientDeviceId, ciphertext, messageType, ephemeral? }`.

1. Handler in `src/routes/messages.ts` validates input.
2. Verifies sender device belongs to the authenticated user.
3. Verifies recipient device exists (any user).
4. If `ephemeral: true`: skips the database insert entirely. Builds a synthetic message object with a random UUID and an `ephemeral: true` marker, then attempts delivery. If the recipient is offline the message is silently dropped — returns `{ delivery: 'dropped' }`. Ephemeral messages are used by clients for read receipts and typing indicators (things that shouldn't persist).
5. If not ephemeral (default): INSERTs into `messages` (`delivered_at` defaults to `null`).
6. Calls `deliverToDevice(recipientDeviceId, message)`:
   - First checks local socket Map. If found, writes the JSON frame and returns `"delivered_local"`.
   - Otherwise looks up `presence:device:<id>` in Redis to find which instance the device is connected to. If a remote instance, publishes to `instance:<that_uuid>` and returns `"delivered_remote"`.
   - If no socket and no presence, returns `"offline"`. Message stays in Postgres for the recipient to fetch later.
7. Returns `{ message, delivery }` with HTTP 201 (or `{ delivery }` only for ephemeral).

### Flow 6: realtime delivery (WebSocket)

Client opens `wss://.../ws`.

1. The HTTP upgrade succeeds. Handler in `src/routes/ws.ts` runs once.
2. Client immediately sends `{ "type": "auth", "token", "deviceId" }`.
3. Server validates the session and that the device belongs to the user.
4. Server registers the socket in the in-process Map (`setLocalSocket`).
5. Server writes `presence:device:<id> = INSTANCE_ID` with 60s TTL.
6. Server sends `{ "type": "auth_ok" }` to the client.
7. Server runs `flushBacklog(deviceId)` — SELECTs all undelivered messages for the device and writes them as `{ "type": "message", "message": ... }` frames.
8. Going forward, any message inserted via `POST /messages` whose recipient is this device gets pushed down the open socket either directly or via pub/sub.
9. Client acks delivered messages with `{ "type": "ack", "messageIds": [...] }`. Server UPDATEs `delivered_at` for those IDs (only if they're actually addressed to the connected device).

On disconnect (`socket.on('close')`):
- Local socket Map entry cleared.
- Presence key in Redis deleted (but only if we still own it — defends against reconnect races).
- `devices.lastSeen` updated in Postgres (fire-and-forget — failures are logged but don't block shutdown).
- The 30s presence refresher stops touching the key. While connected, the refresher also bulk-updates `lastSeen` for all active devices every 30 seconds, so a hard crash doesn't leave `lastSeen` permanently stale.

### Flow 7: catching up via REST (when WebSocket isn't available)

`GET /messages?deviceId=...&since=...&limit=...` returns undelivered messages for the device, ordered by `createdAt` ascending. `POST /messages/ack` flips `delivered_at`. This is the REST fallback for clients without a live WebSocket. Same storage, different channel.

### Flow 8: querying presence

Client (authenticated) sends: `GET /users/:userId/presence`.

1. Handler in `src/routes/presence.ts` validates the target userId.
2. Rate-limited at 60 requests/minute per calling user.
3. Checks the target user's `presenceVisibility` setting. If `'nobody'`, returns `{ online: false, lastSeen: null }` — indistinguishable from a genuinely offline user, which prevents probing.
4. Looks up all devices for the target user.
5. For each device, checks `presence:device:<id>` in Redis. If any key exists, the user is online.
6. If no device is online, returns the latest `lastSeen` timestamp across all their devices.
7. Response: `{ online: boolean, lastSeen: string | null }`.

Users can control their own visibility via `PATCH /me` with `{ presenceVisibility: 'everyone' | 'nobody' }`.

---

## Client-side conventions

Some "chat features" live entirely in the client. The server sees them as ordinary (or ephemeral) messages with opaque ciphertext — it doesn't know what's inside.

### Read receipts

When a client receives and displays a regular text message, it sends a read receipt back to the sender as an ephemeral message. The decrypted JSON payload inside the ciphertext:

```json
{ "type": "read_receipt", "messageIds": ["<uuid>"], "readAt": "<ISO 8601>" }
```

Because it uses `ephemeral: true`, the receipt is dropped if the sender is offline — no stale receipts accumulate. The sender's client detects the structured JSON by attempting to parse decrypted plaintext; if `type` is `"read_receipt"`, it updates the local message state rather than displaying it as a chat message.

### Typing indicators

While a user is typing, their client sends ephemeral messages with:

```json
{ "type": "typing", "state": "started" }
```

When the user sends the message (or stops typing), the client sends:

```json
{ "type": "typing", "state": "stopped" }
```

Both use `ephemeral: true`. The receiving client shows a "typing..." indicator and auto-clears it after 10 seconds (safety net for crashes or network drops). Typing indicators are never persisted.

---

## How the pieces share state

- **Connection objects** (`db`, `redis`, pub/sub clients) are module-scope singletons created once at process startup. Route files import them.
- **Per-request state** lives on Fastify's `request` object — `request.session` for REST routes after `requireAuth`. For WebSocket connections, the per-connection state (`authedDeviceId`) lives in the closure of the connection handler.
- **Cross-request, durable state** (users, devices, keys, messages) lives in Postgres.
- **Cross-request, ephemeral state** (sessions, presence, pending operations) lives in Redis. Auto-expires via TTL.
- **Cross-process state** lives in Redis only. The in-process socket Map is local to each Node process; the pub/sub layer is how processes talk to each other.

---

## Production vs local

Same code, different env vars. Locally, `.env` is loaded by `dotenv-cli` in the `npm run dev` script. On Railway, env vars are set in the dashboard. `DATABASE_URL` and `REDIS_URL` resolve to internal Railway network addresses in production, public proxy URLs locally (since local dev shares the production DB — a deliberate shortcut).

Deployment flow: `git push` → CI runs (`npm ci`, lint, type-check, build) → on green, Railway clones, runs `npm ci`, `npm run build`, then `npm start`. Live in about 90 seconds.

---

## Hardening — implemented

(See "Hardening — planned" below for the work currently being done.)

- **Atomic operations** — find-or-create user, prekey consumption, message ack are all single SQL statements with row-level locking where it matters. No TOCTOU windows.
- **Authorization on every protected endpoint** — `requireAuth` for REST, in-band auth for WebSocket. Ownership checks (this device must belong to this user) on every mutation.
- **No data leak in 404s vs 403s** — looking up a resource that exists-but-isn't-yours returns 404, not 403, to avoid enumeration attacks.
- **Cryptographic randomness everywhere** — session tokens and instance IDs use `crypto.randomBytes` / `crypto.randomUUID`. No `Math.random()` for security-sensitive values.
- **Fail-fast configuration** — every module that depends on env vars throws on startup if they're missing.
- **CI gate on deploys** — Railway waits for GitHub Actions to pass before promoting a build. Broken code doesn't reach production.

---

## Operations

- **`scripts/cleanup-used-prekeys.ts`** — deletes one-time prekeys that were consumed more than 90 days ago. Run with `npx tsx scripts/cleanup-used-prekeys.ts`.
- **`scripts/cleanup-delivered-messages.ts`** — deletes messages where `delivered_at` is older than 7 days. Run with `npx tsx scripts/cleanup-delivered-messages.ts`. Wire to a Railway cron for automatic cleanup.

---

## What's not built yet

Roughly in the order they'd be added:

- **Hardening continued** — abuse handling, separation of dev and prod databases, structured error logging.
- **Multi-device fan-out for `GET /keys/:userId`** — return all of a user's devices in one bundle. See appendix.
- **Groups** — `groups` and `group_members` tables, sender-key distribution, fan-out per group send. See appendix.
- **Media** — encrypted file uploads to object storage, referenced from message ciphertexts.
- **Push notifications** — APNs/FCM wake-ups for offline devices.

---

# Appendix: Future features (design sketches)

These features aren't required for the current scope but the design is sketched here so they can be implemented later without re-thinking the architecture.

## Multi-device fan-out

**Problem.** Right now `GET /keys/:userId` returns a bundle for one device — the most recently registered. If a user has a phone *and* a laptop, only one device is reachable. Real WhatsApp/Signal let users have multiple devices that all receive messages simultaneously.

**The shape of the change.**

The schema doesn't need to change — `devices` already supports many devices per user. The work is in three places:

1. **`GET /keys/:userId` returns an array.** Instead of `{ deviceId, registrationId, identityKey, signedPreKey, preKey }`, return `{ devices: [ {...bundle for device 1}, {...bundle for device 2}, ... ] }`. Each entry consumes its own one-time prekey atomically.

2. **The sender encrypts the same plaintext N times.** Once per recipient device. This is sender-side fan-out, performed entirely on the client. The server still receives N independent ciphertexts (one per recipient device) via N independent `POST /messages` calls.

3. **The sender's own other devices also need a copy.** If Alice has a phone and a laptop and sends from her phone, the laptop needs to see "you sent: hello" in the conversation. So Alice's phone also fetches her own user's key bundle and encrypts to each of her *other* devices. This is "self-fanout."

**Implementation notes.**

- The one-time prekey consumption query stays the same per-device; we just run it N times in a single endpoint call. Wrap in a transaction so either all bundles succeed or none do.
- The bundle endpoint should handle a device with no unused prekeys gracefully — return the rest of the bundle with `preKey: null`. The X3DH handshake still works without a one-time prekey, just with weaker forward secrecy.
- Add a query parameter `?exclude=<deviceId>` so a client doesn't fetch a bundle for the calling device itself.
- Sender fan-out is a client concern, not a server one. The server doesn't change for sender fan-out beyond returning the right bundles.

**What this unlocks.** Users can install the app on multiple devices and have all of them receive every message. "WhatsApp Web alongside the phone" pattern.

**Estimated effort.** ~1-2 hours. Mostly small surgery in `keys.ts`, a transaction wrapper, and adjusting the response shape.

## Groups

**Problem.** Currently messages are 1:1 — one sender device to one recipient device. Groups in Signal-style systems use **sender keys**: each group member has a long-lived symmetric key for that group, distributed to other members via individual pairwise Signal sessions. Group messages are encrypted *once* with the sender's sender-key, then delivered to every other member via the normal per-device mailbox.

**Schema additions.**

```ts
export const groups = pgTable('groups', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name'),
  createdBy: uuid('created_by').notNull().references(() => users.id),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

export const groupMembers = pgTable('group_members', {
  groupId: uuid('group_id').notNull().references(() => groups.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  joinedAt: timestamp('joined_at').notNull().defaultNow(),
  role: text('role').notNull().default('member'), // 'admin' | 'member'
}, (table) => ({
  pk: primaryKey({ columns: [table.groupId, table.userId] }),
}));
```

Note the server does *not* store any group cryptographic state. Sender keys live on clients; the server only knows membership.

**Endpoints.**

- `POST /groups` — create a group, body `{ name, memberUserIds }`. Returns the new group ID.
- `POST /groups/:groupId/members` — add members (admin only).
- `DELETE /groups/:groupId/members/:userId` — remove a member.
- `GET /groups/:groupId` — get group metadata and member list.
- `GET /groups` — list groups the calling user is in.

**Message-send change.**

`POST /messages` gets an optional `groupId` field. When present, the server:

1. Verifies the sender is a member of the group.
2. Looks up all member user IDs.
3. For each member, looks up all their devices (excluding the sender's own device).
4. **The client is responsible for providing one ciphertext per recipient device.** The body for a group send looks like:

   ```ts
   {
     groupId: "...",
     senderDeviceId: "...",
     deliveries: [
       { recipientDeviceId: "...", ciphertext: "...", messageType: 0 },
       { recipientDeviceId: "...", ciphertext: "...", messageType: 0 },
       ...
     ]
   }
   ```

5. Server inserts one row per delivery, then attempts realtime push on each one. Wrap in a transaction.

**Sender-key distribution.**

When a new member joins, every existing member's client must send the new member a copy of their sender key — via a pairwise Signal session (so a normal `POST /messages` with `messageType` set to a "sender-key distribution" type). The server doesn't know this is happening; it's just routing ciphertext.

When a member leaves, all remaining members must rotate their sender keys (otherwise the kicked member could still decrypt future messages from cached state). Again, this is a client concern; the server's only job is to inform other members via a message that the kick happened so they know to rotate.

**Implementation notes.**

- The "one ciphertext per recipient device" pattern means a 50-person group with average 1.5 devices each becomes ~75 message inserts per send. Wrap the whole thing in a single transaction so partial failures roll back cleanly.
- Add a separate `group_messages` table or just keep using `messages` — the latter is simpler; you can JOIN through `group_members` to figure out group context if needed for analytics. Probably add an optional `group_id` column on `messages` for ergonomic lookups ("show me all messages from this group across my devices").
- The fan-out makes sends expensive. For groups beyond a few hundred members, you'd switch to a different distribution strategy (e.g. dropping members into a queue and fanning out asynchronously). Not a concern at the scale we're discussing.

**What this unlocks.** Group chats. The hardest features (consistent membership across all devices, key rotation on member changes, large-group performance) are mostly client-side or operational, not architectural — the server stays a dumb relay.

**Estimated effort.** ~1 full day for the minimum-viable version. More if you want admin transfer, group avatars, etc.
