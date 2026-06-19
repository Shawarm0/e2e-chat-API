# Chat features for e2e-chat-API: read receipts, typing indicators, presence

You are working on `e2e-chat-API`, an end-to-end encrypted chat backend modelled on Signal/WhatsApp. The backend is a Node + TypeScript service using Fastify, deployed on Railway with Postgres + Redis. There's also a Python CLI client at `message-test/message_test/` (or similar — check the directory layout) that exercises the backend end-to-end.

**Before doing anything else, read `BACKEND_OVERVIEW.md` in the repo root.** It documents the architecture in detail. Read it carefully and refer back to it as needed. The rest of this prompt assumes you understand it.

Also read through the Python client source so you know how it currently calls the backend.

## What I want from this session

Add three user-facing chat features. The work spans the backend, the database schema, and the Python client — touch all three layers where each feature needs it. Six tasks below. Do them **in order**, one at a time. Before each task, propose your plan in a short paragraph, then implement, then briefly summarise what changed and which files. Wait for me to acknowledge before moving to the next task. If a task implies design choices (naming, scope, exact defaults), pick reasonable defaults and note them — don't pile up questions.

After each task: run `npm run build` and `npm run lint` and confirm both pass. For Python changes, no formal check — just make sure imports resolve and the file parses (`python -c "import ast; ast.parse(open('<file>').read())"`).

Branching: create a new branch `chat-features` from `main` at the start. Commit after each task with a clear message. Don't push until I say so.

---

## Architectural principle to internalise before you start

Most "chat features" are client features. Read receipts, typing indicators, emoji — these are all just encrypted messages with a different *shape inside the ciphertext*. The server doesn't know they exist; it routes them like any other message.

The exception is when a feature needs **ephemeral delivery** (don't store in the DB at all) or **server-side aggregation** (like presence across multiple devices). Those need backend changes.

So:
- **Read receipts**: client-side convention. Server gets a small change (ephemeral flag) so receipts don't accumulate forever in the messages table.
- **Typing indicators**: client-side convention, but uses the same ephemeral flag.
- **Presence**: backend change (new endpoint, lastSeen tracking).
- **Emoji**: nothing to do anywhere. Unicode goes through the ciphertext channel unchanged. Don't add anything for this.

---

## Task 1 — Ephemeral message delivery

Add an opt-in flag on `POST /messages` for ephemeral messages: deliver via WebSocket if the recipient is online, but **do not store** in the messages table. If the recipient is offline, the message is dropped entirely.

**Schema change**: none. Ephemeral messages never touch the DB.

**API change**: extend the `sendMessageSchema` in `routes/messages.ts` with an optional `ephemeral: z.boolean().optional().default(false)` field. When `ephemeral: true`:

- Skip the `db.insert(messages)` step entirely.
- Still validate sender ownership and recipient existence (the existing checks).
- Still call `deliverToDevice(...)`. If it returns anything other than `delivered_local` or `delivered_remote`, the message is silently dropped — that's the design.
- The response shape should include `delivery: 'delivered_local' | 'delivered_remote' | 'dropped'`. When `ephemeral: true` and the recipient was offline, return `delivered: 'dropped'`. The HTTP status is still 201 for "yes I processed your request" — the client cares about the `delivery` field for what actually happened.

**Important**: the WebSocket frame the recipient sees needs an `ephemeral: true` marker so the client knows not to ack it (ephemeral messages have no row to ack — there's nothing to flip `delivered_at` on). Update `deliverToDevice` (or wrap it) so the frame written to the socket includes this flag when appropriate.

Don't change the existing `ws.ts` ack handler — the client just won't send acks for ephemeral messages, so the handler's existing "ignore messages I don't own" filter is fine.

**Python client change**: add a `--ephemeral` flag to the send code path that sets the new field. Or simpler: don't expose it on the input prompt, but provide a Python-internal helper so tasks 2 and 3 can use it.

## Task 2 — Read receipts (client-side, backend untouched)

This is a client-only feature. The server already does everything needed.

**The convention**: when a client receives a message (non-ephemeral, has an ID), and the user actually *views* that message (in our CLI, just when it arrives — there's no "viewed" event), the client sends a separate message back to the original sender's device with a structured payload.

Define the read-receipt content shape inside the existing message ciphertext as JSON:

```json
{
  "type": "read_receipt",
  "messageIds": ["<uuid>", "<uuid>"],
  "readAt": "<ISO timestamp>"
}
```

For our CLI, since there's no real Signal encryption yet, this JSON goes into the `ciphertext` field base64-encoded the same way text does. The client distinguishes a regular text message from a read receipt by trying to JSON-parse the decoded plaintext: if it parses to `{type: "read_receipt", ...}`, treat as a receipt; otherwise treat as text.

(This is a hack — in a real Signal client the receipt would be a distinct protobuf payload inside the encrypted blob. For our purposes the JSON-detection hack is fine and makes intent visible.)

**Client behaviour**:

1. After receiving a regular text message, immediately send a read receipt back to the sender's device. Use `ephemeral: true` from Task 1 — read receipts shouldn't persist if the original sender is offline; if they come back, the user just won't see the tick. (Real WhatsApp persists receipts; we're simplifying.)
2. When receiving an incoming message, check if it's a read receipt. If yes, log it visibly: `✓ read by <sender device prefix> at <time>`. Don't print it as a chat message.
3. When sending a text message, track its message ID locally so receipts can be matched.

**Server change**: none. Receipts flow through the existing pipes.

## Task 3 — Typing indicators

This is a client-driven, ephemeral feature.

**The convention**: when a user is typing, the client periodically (every ~3 seconds while keystrokes are happening) sends an ephemeral message to the recipient device(s) with payload:

```json
{ "type": "typing", "state": "started" }
```

When the user stops typing (5 seconds without a keystroke, or they press Enter to send), send:

```json
{ "type": "typing", "state": "stopped" }
```

Both messages use `ephemeral: true`. They never get stored.

**Client behaviour**:

1. Detect when the user is typing. In our CLI this is tricky since `input()` is blocking. Use a non-blocking input approach — `prompt_toolkit` is a clean library, or a manual `select`-based loop on stdin. Pick whichever is simpler; I trust your judgement.
2. While the user has typed at least one character but hasn't pressed Enter, send `{"type": "typing", "state": "started"}` every 3 seconds.
3. When the user presses Enter (sends the message) or 5 seconds pass without a keystroke, send `{"type": "typing", "state": "stopped"}`.
4. When receiving a typing indicator, display `<sender prefix> is typing...` on a dedicated status line. Clear it when a `stopped` is received OR when a real message from the same sender arrives OR after 10 seconds (timeout safety net).

**Server change**: none beyond Task 1. Typing indicators are just ephemeral messages with a particular content shape.

If `prompt_toolkit` is too heavy a dep, fall back to a simpler approach: send a "typing started" the moment the user begins, send "stopped" only when they press Enter. Loses the 3-second heartbeat but the feature still works.

## Task 4 — Last-seen tracking

To support presence in Task 5, we need to know when a device was last connected.

**Schema**: the `devices.lastSeen` column already exists in `db/schema.ts` but is never written. Wire it up.

In `routes/ws.ts`, in the `socket.on('close', ...)` handler, after the existing `markOffline(authedDeviceId)`, also update `devices.lastSeen = new Date()` in Postgres for that device. Use a fire-and-forget pattern — if it fails, log via `wsLog.error(...)` and move on. The connection is already closed; we don't want to block shutdown on a slow DB write.

Also write `lastSeen` periodically while connected, not just on disconnect. Otherwise if a process crashes hard, `lastSeen` will be stale. Suggested approach: piggyback on the existing presence refresher in `realtime/presence.ts`. Every 30 seconds (already running) it can also update `lastSeen` for each active device. Add a helper to `db/client.ts` or wherever feels natural — `bulkUpdateLastSeen(deviceIds: string[])` that does a single UPDATE for efficiency.

**No new endpoint yet** — the `lastSeen` writes are setup work for Task 5.

## Task 5 — Presence endpoint

A `GET /users/:userId/presence` endpoint that returns whether a user is online and when they were last seen, aggregated across all their devices.

**Endpoint behaviour**:

- Authenticated (use `requireAuth`).
- Rate-limited (60/min per requesting user — adjust if you think differently).
- Looks up all devices for `:userId`.
- For each device: check `presence:device:<id>` in Redis. If any key exists → user is online.
- If no device is online: take `max(devices.lastSeen)` across the user's devices. That's the "last seen" timestamp.
- Response shape: `{ online: boolean, lastSeen: string | null }` where `lastSeen` is an ISO timestamp.

Path: `src/routes/presence.ts`. Wire it into `server.ts`.

**Privacy setting**: add a `presenceVisibility` column to the `users` table — `text` with allowed values `'everyone' | 'nobody'`, default `'everyone'`. Generate and apply the migration.

If the target user's `presenceVisibility` is `'nobody'`, the endpoint always returns `{ online: false, lastSeen: null }` — same shape, just always says "no" so it's indistinguishable from a genuinely offline-and-never-seen user. (This protects against probing.)

Allow the calling user to update their own setting via `PATCH /me`. Extend the existing `updateMeSchema` in `routes/me.ts` to include an optional `presenceVisibility: z.enum(['everyone', 'nobody']).optional()`.

**Python client change**: when a recipient is resolved (in `resolve_recipient`), also poll `GET /users/:userId/presence` once and display the status: `Talking to <prefix> — last seen <time>` or `Talking to <prefix> — online`. Don't add continuous polling; one snapshot at the start of the session is enough for the demo.

## Task 6 — Cleanup script for delivered messages

The `messages` table grows unboundedly right now — delivered messages are never deleted. Add a cleanup script at `scripts/cleanup-delivered-messages.ts` that deletes rows where `delivered_at IS NOT NULL AND delivered_at < now() - interval '7 days'`. Log the count deleted.

Same shape as the existing `scripts/cleanup-used-prekeys.ts` (if it exists — check; if not, mention it but don't add it now). Make sure it runs with `npx tsx scripts/cleanup-delivered-messages.ts`.

I'll wire this to a Railway cron separately.

---

## Style / conventions you should pick up from the repo

- TypeScript strict mode. No `any`. ESM imports with `.js` extensions on relative imports.
- Zod for request validation. `safeParse`, return 400 with `parseResult.error.issues` on failure.
- Drizzle for SQL. Atomic operations where there's concurrency.
- `requireAuth` hook for protected REST endpoints. In-band auth for WebSockets.
- Module-scope singletons for connections; per-request state on `request`.
- Use `request.log` and the `logger` exported from `src/logger.ts` — no `console.log` for application code.
- For the Python client: match the existing style. ANSI colors via the `C` class, logged HTTP via the `http()` helper, profile persistence via the existing JSON pattern.

## What you should NOT do

- Don't add features beyond what's listed. If you spot something worth doing, mention it but don't act without asking.
- Don't refactor existing structure unless a task explicitly requires it.
- Don't touch the rate-limiting, auth, or key-management code unless a task says to.
- Don't add tests in this session (we'll do them as a separate pass).
- Don't push to remote.

## What to update in `BACKEND_OVERVIEW.md`

After all six tasks, do a single pass to update the overview doc:

- Add the ephemeral message flag to the "Flow 5" description.
- Add the new `GET /users/:userId/presence` and `PATCH /me` extensions to the endpoint list.
- Add a new section "Client-side conventions" describing the read-receipt and typing-indicator content shapes inside encrypted messages.
- Update the "what's not built yet" list — strike read receipts, typing, presence, since they'll be done.
- Add the new cleanup script to the operations section.

Keep the doc style consistent — prose-heavy where it explains rationale, sparing on bullets.

---

When you're ready, start by reading `BACKEND_OVERVIEW.md`, glancing at the Python client, then propose your plan for Task 1.
