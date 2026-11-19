// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { config } from '@core/env';
import { initLogger, LOG_DOMAINS, logger } from '@core/logger';

import { start_api } from './app';

const http_logger = logger.child({ domain: LOG_DOMAINS.HTTP });

initLogger();
const api = start_api({ host: config.app.host, port: config.app.port });

/** Closes every connection, stops the loops and the database, and exits 0: what a container
 * stop or Ctrl-C asks. The apply loops resume from the database on the next start. */
async function shut_down(signal: NodeJS.Signals): Promise<void> {
  http_logger.info('Shutting down', { signal });
  await api.stop();
  process.exit(0);
}

process.once('SIGTERM', (signal) => void shut_down(signal));
process.once('SIGINT', (signal) => void shut_down(signal));
