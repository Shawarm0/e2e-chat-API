import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { logger } from '../logger.js';

// Applies any drizzle migrations the database has not seen yet, at boot.
//
// This exists because the Railway Postgres has no public endpoint, so there is
// no way to run drizzle-kit against it from a laptop. Drizzle records what it
// has applied in drizzle.__drizzle_migrations, so this is a no-op on a database
// that is already current.
//
// It assumes one instance starts at a time. If this ever runs on several
// instances concurrently, move it to a release step instead — two processes
// applying the same migration will collide.
export async function runMigrations(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set');
  }

  // The migrator wants its own single connection, separate from the app pool.
  const client = postgres(connectionString, { max: 1 });
  try {
    await migrate(drizzle(client), { migrationsFolder: 'drizzle' });
    logger.info('migrations up to date');
  } finally {
    await client.end();
  }
}
