# Hardening pass for e2e-chat-API backend

You are working on `e2e-chat-API`, an end-to-end encrypted chat backend modelled on Signal/WhatsApp. The backend is a Node + TypeScript service using Fastify, deployed on Railway with Postgres + Redis. Before doing anything else, read `BACKEND_OVERVIEW.md` in the repo root — it documents the architecture in detail. Read it carefully and refer back to it as needed; the rest of this prompt assumes you understand it.

## What I want from this session

Do a focused hardening pass on the backend. The goal is production-grade resilience without changing any behaviour observable to a correctly-behaved client. Eight tasks below. Do them **in order**, one at a time. Before each task, propose your plan in a short paragraph, then implement, then briefly summarise what changed. Wait for me to acknowledge before moving to the next task. If a task implies design choices (library to use, naming, scope), pick reasonable defaults and note them — don't bombard me with questions.

After each task: run `npm run build` and confirm it compiles. If lint is set up, run `npm run lint` too. Don't run `npm run dev` (I'll test manually).

Branching: create a new branch `hardening` from `main` at the start. Commit after each task with a clear message (`Add rate limiting to /auth/request-code`, etc.). Don't push until I tell you.

---

## Task 1 — Rate limit `/auth/request-code`

Add per-phone-number and per-IP rate limits. Suggested defaults:

- **Per phone number:** 3 requests per hour.
- **Per IP:** 10 requests per hour.

Implementation: use Redis with `INCR` + `EXPIRE` pattern (or `SET ... NX EX` for the first request followed by `INCR`). Don't reach for `@fastify/rate-limit` unless it cleanly supports per-key custom limits with Redis as the store — a small custom helper is fine and keeps the logic transparent.

On limit exceeded, return HTTP 429 with a JSON body like `{ "error": "Too many requests, try again in X seconds" }` and a `Retry-After` header. The exact seconds value should reflect when the bucket actually resets.

Put the rate-limit helper in a new module, e.g. `src/ratelimit/limiter.ts`. Keep it generic so subsequent tasks can reuse it.

## Task 2 — Rate limit `/auth/verify-code`

Same library/helper as Task 1. Suggested defaults:

- **Per phone number:** 10 attempts per hour.
- **Per IP:** 30 attempts per hour.

Twilio already enforces its own per-code attempt limit (5 wrong tries kills the code), so these limits are about preventing pump-and-dump abuse, not about brute-forcing a code.

## Task 3 — Rate limit other write endpoints

Apply the same limiter to:

- `POST /messages` — suggested: 60/min per device.
- `POST /devices` — suggested: 5/hour per user.
- `POST /devices/:deviceId/prekeys` — suggested: 30/hour per device.

For these, key on `userId` or `deviceId` (from `request.session`) rather than IP, since they're authenticated.

## Task 4 — Used-prekey cleanup

Write a small standalone script `scripts/cleanup-used-prekeys.ts` that deletes `one_time_prekeys` rows where `used = true AND used_at < now() - interval '90 days'`. It should log how many rows it deleted.

Don't try to schedule it from inside the running server. Just provide the script. I'll wire it to a Railway cron job separately. Make sure it can be run with `npx tsx scripts/cleanup-used-prekeys.ts`.

## Task 5 — Structured logging with request IDs

Fastify auto-generates a `request.id` per request. Make sure every log line emitted during request handling includes it. Specifically:

- Audit `fastify.log.error(...)` calls throughout the routes; ensure they pass `request.id` (or just use `request.log.error(...)` which does it automatically). Same for `request.log.warn`, `request.log.info`.
- For the WebSocket route, each connection should have a per-connection log child (`fastify.log.child({ wsConnectionId: someId })`) used for all log lines from that connection's handler.
- For the cross-instance pub/sub messages, include the `INSTANCE_ID` in any log lines.

Goal: when something goes wrong in production, I can grep one log line and find every related log line.

## Task 6 — Stricter input validation

Add `libphonenumber-js` and use it to validate phone numbers properly in both `/auth/request-code` and `/auth/verify-code`. Use `parsePhoneNumberFromString(input)` and require `.isValid()` to be true; if not, return 400 with a clear error. The phone number should be normalised to E.164 before being passed to Twilio.

Also audit other Zod schemas in the codebase for sane bounds:

- `deviceName`: already capped at 100. Keep.
- `ciphertext` in `/messages`: cap at, say, 65536 bytes (64 KiB). Real Signal ciphertexts are well under 1KB; 64KiB is paranoid headroom.
- Anywhere that takes an array (`oneTimePreKeys`, `messageIds` for ack, etc.): confirm there's a `.max(...)` and that it's reasonable.

Don't add validation just for the sake of it. Look for unbounded inputs and bound them.

## Task 7 — Graceful shutdown

When the process receives `SIGTERM` (which Railway sends on redeploy) or `SIGINT` (Ctrl-C locally):

1. Stop accepting new HTTP connections (`fastify.close()` handles this).
2. Close all open WebSocket connections with code 1001 ("going away") so clients can reconnect cleanly to the new instance.
3. Mark all locally-connected devices offline in Redis (clear their presence keys).
4. Close the Postgres pool and Redis connections.
5. Exit cleanly within 10 seconds. If anything hangs, force-exit so Railway's shutdown isn't blocked indefinitely.

Implement this in `src/server.ts` or a new `src/shutdown.ts`. Listen on the process signals once. Make sure the order is correct: stop accepting new sockets *before* closing existing ones, otherwise a new connection could come in during the drain.

## Task 8 — Health-check depth

Currently `GET /health` returns `{ok: true}` unconditionally. Replace it with something that actually probes dependencies:

- Run `SELECT 1` against Postgres with a short timeout (say, 2 seconds).
- Run `PING` against Redis with a short timeout.

If both succeed, return 200 with `{ "ok": true, "postgres": "ok", "redis": "ok" }`. If either fails, return 503 with `{ "ok": false, "postgres": "ok|error", "redis": "ok|error" }`.

Also expose a separate `GET /ready` that does the same checks — convention is "health" = "process is alive," "ready" = "process can serve traffic." For our purposes the implementations are the same; just expose both endpoints so Railway can hit `/ready` for its rolling-deploy gate while `/health` stays for general probing. If that's over-engineering for your taste, just make `/health` deep and call it done.

---

## Style / conventions you should pick up from the repo

- TypeScript strict mode is on. No `any`. Use proper types.
- ESM imports with `.js` extensions on relative imports (it's a `"type": "module"` package).
- Zod for request validation. `safeParse`, return 400 with `parseResult.error.issues` on failure.
- Drizzle for SQL. Atomic operations where there's concurrency. No raw SQL unless using `sql\`\`\`` tagged template, in which case the values must be interpolated as parameters.
- Fastify route plugins per resource (`src/routes/foo.ts` exports `fooRoutes(fastify)`).
- Module-scope singletons for connection objects; per-request state on `request`.
- `requireAuth` hook for protected REST endpoints. For WebSockets, in-band auth via JSON frame.
- No `console.log` for application logic; use Fastify's logger (`fastify.log` or `request.log`).

## What you should NOT do

- Don't add tests. (I want to add them as a separate pass; including them here would balloon the diff.)
- Don't add features beyond what's listed. If you spot an unrelated bug, mention it but don't fix it without asking.
- Don't refactor existing structure unless a task explicitly requires it.
- Don't change the deployment configuration or `package.json` scripts beyond adding dependencies and (where required) the cleanup script entry.
- Don't push to remote. I'll review the branch and push it.

---

When you're ready, start by reading `BACKEND_OVERVIEW.md` and the contents of `src/`, then propose your plan for Task 1.
