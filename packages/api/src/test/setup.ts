import postgres from 'postgres';

const isSafeIdentifier = (value: string): boolean => /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);

async function resetPostgresTestDatabase(): Promise<void> {
  if (Bun.env.NODE_ENV !== 'test') return;
  const databaseUrl = Bun.env.DATABASE_URL;
  if (!databaseUrl?.startsWith('postgres')) return;

  const url = new URL(databaseUrl);
  const databaseName = decodeURIComponent(url.pathname.slice(1));
  if (!isSafeIdentifier(databaseName)) {
    throw new Error(`Unsafe test database name: ${databaseName}`);
  }

  const adminUrl = new URL(url);
  adminUrl.pathname = '/postgres';

  const admin = postgres(adminUrl.toString(), { max: 1, onnotice: () => undefined });
  const database = await admin`SELECT 1 FROM pg_database WHERE datname = ${databaseName}`;
  if (database.length === 0) {
    await admin.unsafe(`CREATE DATABASE "${databaseName}"`);
  }
  await admin.end();

  const testDb = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
  await testDb`DROP SCHEMA IF EXISTS drizzle CASCADE`;
  await testDb`DROP SCHEMA IF EXISTS public CASCADE`;
  await testDb`CREATE SCHEMA public`;
  await testDb`GRANT ALL ON SCHEMA public TO public`;
  await testDb.end();
}

await resetPostgresTestDatabase();
export {};
