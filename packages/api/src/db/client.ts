import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

import { config } from '@core/env';

export const sql = postgres(config.database.url);

export const db = drizzle(sql);

export const runMigrations = async (): Promise<void> => {
  await migrate(db, { migrationsFolder: new URL('./migrations', import.meta.url).pathname });
};

export const closeDb = async (): Promise<void> => {
  await sql.end();
};
