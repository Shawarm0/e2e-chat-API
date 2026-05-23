import { defineConfig } from 'drizzle-kit';

// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
export default defineConfig({
    schema: './src/db/schema.ts',
    out: './drizzle',
    dialect: 'postgresql',
    dbCredentials: {
        // @ts-expect-error - process is a Node global, type defs not in scope for this config file
        url: process.env.DATABASE_URL!,
    },
});
