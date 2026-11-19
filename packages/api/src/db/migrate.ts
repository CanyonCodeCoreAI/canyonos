// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { close_db, run_migrations } from './client';

await run_migrations();
await close_db();
console.log('Migrations complete');
process.exit(0);
