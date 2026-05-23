# e2e-chat-API

End-to-end encrypted chat backend, work in progress.

## Stack

- Node + TypeScript
- Fastify
- PostgreSQL via Drizzle ORM
- Redis (ioredis)
- Twilio Verify for phone auth
- Deployed on Railway

## Scripts

- `npm run dev` — start the dev server with hot reload (loads `.env`)
- `npm run build` — compile TypeScript to `dist/`
- `npm start` — run the compiled server
- `npm run db:generate` — generate a new migration from schema changes
- `npm run db:migrate` — apply pending migrations
- `npm run db:studio` — open the Drizzle Studio UI for the database

## Environment variables

See `BACKEND_OVERVIEW.md` for the full list. Locally, put them in `.env` (gitignored). On Railway, they're set in the service's Variables tab.

## Documentation

See `BACKEND_OVERVIEW.md` for an explanation of the codebase and request flow.
