import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { and, eq, lt } from 'drizzle-orm';
import { oneTimePreKeys } from '../src/db/schema.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DATABASE_URL is not set');
  process.exit(1);
}

const sql = postgres(connectionString);
const db = drizzle(sql);

const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);

const deleted = await db
  .delete(oneTimePreKeys)
  .where(and(eq(oneTimePreKeys.used, true), lt(oneTimePreKeys.usedAt, cutoff)))
  .returning({ id: oneTimePreKeys.id });

console.log(`Deleted ${deleted.length} used prekeys older than 90 days`);

await sql.end();
