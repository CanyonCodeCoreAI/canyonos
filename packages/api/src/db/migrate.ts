// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { closeDb, runMigrations } from './client';

await runMigrations();
await closeDb();
console.log('Migrations complete');
process.exit(0);
