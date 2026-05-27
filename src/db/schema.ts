import { pgTable, uuid, text, timestamp, integer, boolean, unique, index } from 'drizzle-orm/pg-core';

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  phoneNumber: text('phone_number').notNull().unique(),
  displayName: text('display_name'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

export const devices = pgTable('devices', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  deviceName: text('device_name'),
  registrationId: integer('registration_id').notNull(),
  identityKeyPublic: text('identity_key_public').notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  lastSeen: timestamp('last_seen'),
});

export const signedPreKeys = pgTable('signed_prekeys', {
  id: uuid('id').primaryKey().defaultRandom(),
  deviceId: uuid('device_id').notNull().references(() => devices.id, { onDelete: 'cascade' }),
  keyId: integer('key_id').notNull(),
  publicKey: text('public_key').notNull(),
  signature: text('signature').notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, (table) => ({
  uniqueDeviceKeyId: unique().on(table.deviceId, table.keyId),
}));

export const oneTimePreKeys = pgTable('one_time_prekeys', {
  id: uuid('id').primaryKey().defaultRandom(),
  deviceId: uuid('device_id').notNull().references(() => devices.id, { onDelete: 'cascade' }),
  keyId: integer('key_id').notNull(),
  publicKey: text('public_key').notNull(),
  used: boolean('used').notNull().default(false),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  usedAt: timestamp('used_at'),
}, (table) => ({
  uniqueDeviceKeyId: unique().on(table.deviceId, table.keyId),
}));

export const messages = pgTable(
  'messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    senderDeviceId: uuid('sender_device_id')
      .notNull()
      .references(() => devices.id, { onDelete: 'cascade' }),
    recipientDeviceId: uuid('recipient_device_id')
      .notNull()
      .references(() => devices.id, { onDelete: 'cascade' }),
    ciphertext: text('ciphertext').notNull(),
    messageType: integer('message_type').notNull().default(0),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    deliveredAt: timestamp('delivered_at'),
  },
  (table) => ({
    recipientIdx: index('messages_recipient_idx').on(table.recipientDeviceId, table.deliveredAt),
  }),
);
