import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { and, isNotNull, lt } from 'drizzle-orm';
import { messages } from '../src/db/schema.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DATABASE_URL is not set');
  process.exit(1);
}

const sql = postgres(connectionString);
const db = drizzle(sql);

const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

const deleted = await db
  .delete(messages)
  .where(and(isNotNull(messages.deliveredAt), lt(messages.deliveredAt, cutoff)))
  .returning({ id: messages.id });

console.log(`Deleted ${deleted.length} delivered messages older than 7 days`);

await sql.end();
