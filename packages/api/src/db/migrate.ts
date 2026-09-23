import { closeDb, runMigrations } from './client';

await runMigrations();
await closeDb();
console.log('Migrations complete');
process.exit(0);
