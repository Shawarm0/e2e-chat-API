import { pgTable, uuid, text, timestamp, integer } from 'drizzle-orm/pg-core';

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  phoneNumber: text('phone_number').notNull().unique(),
  displayName: text('display_name'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

export const devices = pgTable('devices', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  deviceName: text('device_name'),
  registrationId: integer('registration_id').notNull(),
  identityKeyPublic: text('identity_key_public').notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  lastSeen: timestamp('last_seen'),
});
