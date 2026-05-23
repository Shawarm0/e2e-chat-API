# e2e-chat-API — Backend Overview

A short tour of what exists, where it lives, and which code runs when.

---

## Current state

A Fastify backend in TypeScript, deployed to Railway. It supports phone-number authentication via Twilio SMS, and issues session tokens stored in Redis. User accounts and devices live in Postgres. No messaging logic yet — that comes next.

### Tech stack

- **Fastify** — HTTP web framework.
- **Drizzle ORM** + **postgres** — typed database access against PostgreSQL.
- **ioredis** — Redis client for ephemeral state.
- **Twilio Verify** — SMS one-time code delivery and validation.
- **TypeScript** + **tsx** — types in dev, compiled to JS for production.

### Project structure

```
src/
├── server.ts              entry point — boots Fastify, registers routes
├── auth/
│   └── requireAuth.ts     hook that validates session tokens on protected routes
├── db/
│   ├── client.ts          opens the Postgres connection
│   └── schema.ts          users + devices table definitions
├── redis/
│   └── client.ts          opens the Redis connection
├── routes/
│   ├── health.ts          GET /health
│   ├── auth.ts            POST /auth/request-code, POST /auth/verify-code
│   └── me.ts              GET /me (protected)
├── sessions/
│   └── store.ts           createSession, getSession, revokeSession
└── twilio/
    └── client.ts          sendVerificationCode, checkVerificationCode
```

### Environment variables (loaded from `.env` locally, Railway dashboard in production)

- `DATABASE_URL` — Postgres connection string.
- `REDIS_URL` — Redis connection string.
- `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_VERIFY_SERVICE_SID` — Twilio credentials.
- `PORT` — set by Railway in production; defaults to 3000 locally.

Every module that needs these reads them from `process.env` at startup and throws immediately if they are missing. This is fail-fast — a misconfigured deployment crashes loudly instead of silently misbehaving.

---

## How startup works

When the server process boots:

1. **`src/server.ts` runs.** It imports the route modules. Each route import triggers its own imports, which is how the database, Redis, and Twilio clients get created.
2. **`src/db/client.ts` runs once.** Reads `DATABASE_URL`, opens a Postgres connection pool (via the `postgres` library), wraps it in Drizzle's typed query builder, exports `db`. The pool holds ~10 open TCP connections to reuse across requests.
3. **`src/redis/client.ts` runs once.** Reads `REDIS_URL`, opens an `ioredis` connection, exports `redis`.
4. **`src/twilio/client.ts` runs once.** Reads the three Twilio env vars, constructs a Twilio client, exports two helper functions (`sendVerificationCode`, `checkVerificationCode`).
5. **`server.ts` registers the route plugins.** Each call to `fastify.register(...)` invokes a function that attaches routes to the Fastify instance.
6. **`fastify.listen(...)`** opens the HTTP socket on the chosen port and starts accepting connections.

After this, the process sits in the Node event loop, waiting for requests. Connections to Postgres, Redis, and Twilio stay open in the background.

---

## User flow 1: requesting an SMS code

Client sends: `POST /auth/request-code` with body `{ "phoneNumber": "+447..." }`.

**Code path:**

1. Fastify routes the request to the handler in **`src/routes/auth.ts`**.
2. Handler validates the body — phone number is present and starts with `+`. If not, returns `400`.
3. Handler calls `sendVerificationCode(phoneNumber)` from **`src/twilio/client.ts`**.
4. That function calls `twilioClient.verify.v2.services(SID).verifications.create({ to, channel: 'sms' })` — the Twilio SDK makes an HTTPS request to Twilio's API. Twilio generates the code, sends the SMS, and returns a verification record with `status: "pending"`.
5. Handler returns `{ "status": "pending" }` to the client with HTTP 200.

**Where things come from:** the handler accesses `db`, `sendVerificationCode`, etc. via ESM imports at the top of the file. Those imports run the respective `client.ts` files once (Node caches the module), so the connection setup happens at boot rather than per-request.

**Library functions used:**

- `twilio()` — constructs an authenticated HTTP client for Twilio's API.
- `verifications.create()` — POSTs to `https://verify.twilio.com/v2/Services/.../Verifications` under the hood.

---

## User flow 2: verifying the code

Client sends: `POST /auth/verify-code` with body `{ "phoneNumber": "+447...", "code": "123456" }`.

**Code path:**

1. Handler in **`src/routes/auth.ts`** validates both fields are present (`400` if not).
2. Handler calls `checkVerificationCode(phoneNumber, code)` from **`src/twilio/client.ts`**, which hits Twilio's `VerificationCheck` endpoint.
3. Twilio returns `{ status: "approved" }` if the code matches, `{ status: "pending" }` otherwise.
4. If not approved, handler returns `401 Invalid code`.
5. If approved, handler runs an atomic upsert against the `users` table:

   ```ts
   INSERT INTO users (phone_number) VALUES ($1)
   ON CONFLICT (phone_number) DO UPDATE SET phone_number = $1
   RETURNING *
   ```

   This is one SQL statement, so concurrent requests for the same phone number can't race — Postgres serializes them via a row lock. Either a new user is inserted, or the existing row is returned. Either way, `user` is populated.

6. Handler calls `createSession(user.id)` from **`src/sessions/store.ts`**.
7. `createSession` generates a 32-byte random token via Node's `crypto.randomBytes`, encodes it as base64url, and stores it in Redis:

   ```
   SET session:<token> '{"userId":"...","createdAt":...}' EX 2592000
   ```

   The `EX 2592000` is the 30-day TTL — Redis will auto-delete the key when it expires.

8. Handler returns `{ "user": {...}, "sessionToken": "<43 chars>" }` with HTTP 200.

**Library functions used:**

- `db.insert(...).values(...).onConflictDoUpdate(...).returning()` — Drizzle's query builder. Compiles to a single parameterized SQL statement; the values are passed as separate parameters so user input can't escape into SQL syntax (no injection possible).
- `randomBytes(32)` — Node's built-in cryptographic randomness, drawn from the OS entropy pool.
- `redis.set(key, value, 'EX', seconds)` — Redis `SET` with expiry, atomic in one command.

---

## User flow 3: hitting a protected route

Client sends: `GET /me` with header `Authorization: Bearer <token>`.

**Code path:**

1. Fastify sees the route's `onRequest` hook list and runs **`requireAuth`** from `src/auth/requireAuth.ts` _before_ the handler.
2. `requireAuth` reads `request.headers.authorization`, checks it starts with `Bearer `, slices off the prefix to get the raw token.
3. It calls `getSession(token)` from **`src/sessions/store.ts`**, which runs `GET session:<token>` against Redis.
4. If Redis returns nothing (`null`), `requireAuth` sends `401 Invalid or expired session` and the handler never runs.
5. If a session is found, `requireAuth` parses the JSON, assigns it to `request.session`, and returns without sending a reply — letting Fastify continue to the handler.
6. The handler in **`src/routes/me.ts`** reads `request.session.userId`, runs a SELECT against Postgres to fetch the user, and returns it as JSON.

**Library functions used:**

- `redis.get(key)` — straight Redis lookup; sub-millisecond.
- `db.select().from(users).where(eq(users.id, ...)).limit(1)` — Drizzle's SELECT builder. The `eq()` function returns a typed SQL expression object, not a string, which is what makes the query injection-safe.

---

## How the pieces share state

- **Connection objects (`db`, `redis`, Twilio client)** are created once at module load. They are imported by route files via `import { db } from '../db/client.js';`. Node caches modules, so every file that imports `db` gets the same instance.
- **Per-request state** lives on the `request` object. The `requireAuth` hook attaches `request.session`; route handlers read it. This is scoped to one request — no global mutable state, no risk of one user seeing another user's session.
- **Cross-request state** lives in Postgres (durable: users, devices) or Redis (ephemeral: sessions, later presence and rate limits). The server processes themselves are stateless — restart any instance, no data lost.

---

## Production vs local

Identical code, different env vars. Locally, `.env` is loaded by `dotenv-cli` in the `npm run dev` script. On Railway, env vars are set in the dashboard and injected into the process. The `DATABASE_URL` and `REDIS_URL` on Railway are reference variables that resolve to the internal Railway network addresses for the Postgres and Redis services in the same project. Local dev currently uses the _public_ URLs to reach the same Postgres and Redis (shared with production — a deliberate shortcut for now).

Deployment flow: `git push` → Railway detects the push, clones the repo, runs `npm ci` (install), `npm run build` (TypeScript → JS in `dist/`), `npm start` (runs `node dist/server.js`). Takes about 30 seconds from push to live.

---

## What's not built yet

- Device registration (each user can have multiple devices, each with its own keypair).
- Prekey bundles and the X3DH handshake — the Signal Protocol's session-setup mechanism.
- WebSocket gateway for realtime delivery.
- Message send/receive, history, fan-out for groups.
- Push notifications.
- Rate limiting on auth endpoints.
- Separate dev and prod databases.
