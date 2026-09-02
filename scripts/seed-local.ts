// Seeds the local development database with browsable test data.
// Refuses to run against anything other than a localhost DATABASE_URL.
//
//   npm run db:seed
//
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { randomBytes } from 'node:crypto';
import { users, devices, signedPreKeys, oneTimePreKeys, messages } from '../src/db/schema.js';
import { hashPassword } from '../src/auth/password.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DATABASE_URL is not set');
  process.exit(1);
}

if (!/@(localhost|127\.0\.0\.1)[:/]/.test(connectionString)) {
  console.error('Refusing to seed: DATABASE_URL does not point at localhost');
  console.error('Run with: npm run db:seed (which loads .env.local)');
  process.exit(1);
}

const sql = postgres(connectionString);
const db = drizzle(sql);

// Stand-in for real X25519/Ed25519 material — the shape is right, the bytes are not.
const key = (): string => randomBytes(32).toString('base64');
const signature = (): string => randomBytes(64).toString('base64');
const ciphertext = (): string => randomBytes(96).toString('base64');

const minutesAgo = (n: number): Date => new Date(Date.now() - n * 60_000);
const daysAgo = (n: number): Date => new Date(Date.now() - n * 24 * 60 * 60_000);

// Wipe first so the script is re-runnable. Cascades take out devices, prekeys and messages.
await db.delete(messages);
await db.delete(users);

// Every seeded account shares one password so you can sign in as any of them.
const SEED_PASSWORD = 'password123';
const seedPasswordHash = await hashPassword(SEED_PASSWORD);

const seedUsers = [
  {
    email: 'ada@example.com',
    displayName: 'Ada Lovelace',
    presenceVisibility: 'everyone',
    createdAt: daysAgo(30),
  },
  {
    email: 'grace@example.com',
    displayName: 'Grace Hopper',
    presenceVisibility: 'everyone',
    createdAt: daysAgo(24),
  },
  {
    email: 'alan@example.com',
    displayName: 'Alan Turing',
    presenceVisibility: 'contacts',
    createdAt: daysAgo(12),
  },
  {
    email: 'katherine@example.com',
    displayName: 'Katherine Johnson',
    presenceVisibility: 'nobody',
    createdAt: daysAgo(6),
  },
  {
    email: 'newcomer@example.com',
    displayName: null,
    presenceVisibility: 'everyone',
    createdAt: daysAgo(1),
  },
];

const insertedUsers = await db
  .insert(users)
  .values(seedUsers.map((u) => ({ ...u, passwordHash: seedPasswordHash })))
  .returning();
const byName = new Map(insertedUsers.map((u) => [u.displayName ?? u.email, u]));

// Ada and Grace are multi-device; Turing and Johnson have one each; the
// unnamed user has just signed up and has no device yet.
const deviceSpecs = [
  {
    owner: 'Ada Lovelace',
    deviceName: 'Ada — iPhone 15',
    lastSeen: minutesAgo(2),
    createdAt: daysAgo(30),
  },
  {
    owner: 'Ada Lovelace',
    deviceName: 'Ada — MacBook Pro',
    lastSeen: minutesAgo(45),
    createdAt: daysAgo(20),
  },
  {
    owner: 'Grace Hopper',
    deviceName: 'Grace — Pixel 9',
    lastSeen: minutesAgo(1),
    createdAt: daysAgo(24),
  },
  {
    owner: 'Grace Hopper',
    deviceName: 'Grace — iPad',
    lastSeen: daysAgo(3),
    createdAt: daysAgo(14),
  },
  {
    owner: 'Alan Turing',
    deviceName: 'Alan — Desktop',
    lastSeen: minutesAgo(15),
    createdAt: daysAgo(12),
  },
  {
    owner: 'Katherine Johnson',
    deviceName: 'Katherine — iPhone SE',
    lastSeen: null,
    createdAt: daysAgo(6),
  },
];

const insertedDevices = await db
  .insert(devices)
  .values(
    deviceSpecs.map((d, i) => ({
      userId: byName.get(d.owner)!.id,
      deviceName: d.deviceName,
      registrationId: 1000 + i,
      identityKeyPublic: key(),
      createdAt: d.createdAt,
      lastSeen: d.lastSeen,
    })),
  )
  .returning();

const deviceByName = new Map(insertedDevices.map((d) => [d.deviceName!, d]));

// One current signed prekey per device, plus a rotated-out older one for Ada's phone.
await db.insert(signedPreKeys).values([
  ...insertedDevices.map((d, i) => ({
    deviceId: d.id,
    keyId: 200 + i,
    publicKey: key(),
    signature: signature(),
    createdAt: daysAgo(2),
  })),
  {
    deviceId: deviceByName.get('Ada — iPhone 15')!.id,
    keyId: 199,
    publicKey: key(),
    signature: signature(),
    createdAt: daysAgo(40),
  },
]);

// A pool of one-time prekeys per device, with the first few already claimed so
// the "consumed key" path has data to look at. Katherine's pool is nearly empty.
const preKeyRows = insertedDevices.flatMap((d) => {
  const poolSize = d.deviceName === 'Katherine — iPhone SE' ? 3 : 20;
  const consumed = d.deviceName === 'Katherine — iPhone SE' ? 2 : 4;
  return Array.from({ length: poolSize }, (_, n) => ({
    deviceId: d.id,
    keyId: 500 + n,
    publicKey: key(),
    used: n < consumed,
    createdAt: daysAgo(5),
    usedAt: n < consumed ? daysAgo(1) : null,
  }));
});
await db.insert(oneTimePreKeys).values(preKeyRows);

// A conversation between Ada's phone and Grace's Pixel: older messages delivered,
// the tail still queued. Plus an undelivered backlog for Grace's idle iPad.
const adaPhone = deviceByName.get('Ada — iPhone 15')!;
const gracePixel = deviceByName.get('Grace — Pixel 9')!;
const graceIpad = deviceByName.get('Grace — iPad')!;
const alanDesktop = deviceByName.get('Alan — Desktop')!;
const katherinePhone = deviceByName.get('Katherine — iPhone SE')!;

const thread = Array.from({ length: 12 }, (_, n) => {
  const fromAda = n % 2 === 0;
  const sentAt = minutesAgo(600 - n * 45);
  const delivered = n < 9;
  return {
    senderDeviceId: fromAda ? adaPhone.id : gracePixel.id,
    recipientDeviceId: fromAda ? gracePixel.id : adaPhone.id,
    ciphertext: ciphertext(),
    // 1 = prekey/session-init message, 0 = normal ratchet message.
    messageType: n === 0 ? 1 : 0,
    createdAt: sentAt,
    deliveredAt: delivered ? new Date(sentAt.getTime() + 4_000) : null,
  };
});

const backlog = Array.from({ length: 5 }, (_, n) => ({
  senderDeviceId: alanDesktop.id,
  recipientDeviceId: graceIpad.id,
  ciphertext: ciphertext(),
  messageType: n === 0 ? 1 : 0,
  createdAt: minutesAgo(200 - n * 30),
  deliveredAt: null,
}));

const toKatherine = [
  {
    senderDeviceId: gracePixel.id,
    recipientDeviceId: katherinePhone.id,
    ciphertext: ciphertext(),
    messageType: 1,
    createdAt: minutesAgo(90),
    deliveredAt: null,
  },
];

await db.insert(messages).values([...thread, ...backlog, ...toKatherine]);

const counts = await sql`
  SELECT 'users' AS table, count(*) FROM users
  UNION ALL SELECT 'devices', count(*) FROM devices
  UNION ALL SELECT 'signed_prekeys', count(*) FROM signed_prekeys
  UNION ALL SELECT 'one_time_prekeys', count(*) FROM one_time_prekeys
  UNION ALL SELECT 'messages', count(*) FROM messages
`;

console.log('Seeded local database:');
for (const row of counts) {
  console.log(`  ${String(row.table).padEnd(18)} ${row.count}`);
}
console.log(`\nSign in as any seeded account with password: ${SEED_PASSWORD}`);
for (const user of insertedUsers) {
  console.log(`  ${user.email.padEnd(24)} ${user.displayName ?? '(no display name)'}`);
}

await sql.end();
