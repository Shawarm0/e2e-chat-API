ALTER TABLE "users" ADD COLUMN "email" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "password_hash" text;--> statement-breakpoint
-- Backfill rows that predate email/password auth: the phone number becomes a
-- placeholder address so the unique index holds, and the sentinel hash cannot
-- verify against any password, so those accounts must register again to sign in.
UPDATE "users" SET "email" = "phone_number" || '@legacy.invalid' WHERE "email" IS NULL;--> statement-breakpoint
UPDATE "users" SET "password_hash" = 'disabled' WHERE "password_hash" IS NULL;
