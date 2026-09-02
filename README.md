# e2e-chat-API

End-to-end encrypted chat backend, work in progress.

## Stack

- Node + TypeScript
- Fastify
- PostgreSQL via Drizzle ORM
- Redis (ioredis)
- Email + password auth (scrypt via `node:crypto`)
- Deployed on Railway

## Scripts

- `npm run dev` — start the dev server with hot reload (loads `.env`)
- `npm run dev:local` — same, but against the local database (loads `.env.local`)
- `npm run build` — compile TypeScript to `dist/`
- `npm start` — run the compiled server
- `npm run db:generate` — generate a new migration from schema changes
- `npm run db:migrate` — apply pending migrations
- `npm run db:studio` — open the Drizzle Studio UI for the database
- `npm run db:seed` — fill the local database with test data (refuses non-localhost)
- `npm run db:studio:local` — Drizzle Studio pointed at the local database

## Local database

`.env` points at the deployed Railway Postgres. To work against a local one instead,
`.env.local` (gitignored) points at Postgres and Redis on this machine.

One-time setup:

```sh
brew install postgresql@17 redis
brew services start postgresql@17
brew services start redis
createdb -h 127.0.0.1 e2e_chat_dev
psql -h 127.0.0.1 -d postgres -c "CREATE ROLE postgres LOGIN SUPERUSER PASSWORD 'postgres';"
```

Then apply the schema and load test data:

```sh
npx dotenv -e .env.local -- npx drizzle-kit migrate
npm run db:seed
```

Browsing the data:

```sh
npm run db:studio:local            # GUI at https://local.drizzle.studio
psql postgresql://postgres@127.0.0.1:5432/e2e_chat_dev
```

`npm run db:seed` wipes and reloads the seed data, so it is safe to re-run. It
covers five users (multi-device, single-device and no-device), signed and
one-time prekeys with some already claimed, a delivered message thread, and an
undelivered backlog. See `scripts/seed-local.ts`. Every seeded account signs in
with the password `password123` — for example `ada@example.com`.

## Authentication

`POST /auth/register` with `{ email, password, displayName? }` creates an account and
returns a session token; `POST /auth/login` with `{ email, password }` returns one for
an existing account. Send it as `Authorization: Bearer <token>` on every other route.
Passwords are 8-200 characters, hashed with scrypt from `node:crypto` — no external
auth service is involved.

## Environment variables

See `BACKEND_OVERVIEW.md` for the full list. Locally, put them in `.env` (gitignored). On Railway, they're set in the service's Variables tab.

## Documentation

See `BACKEND_OVERVIEW.md` for an explanation of the codebase and request flow.
