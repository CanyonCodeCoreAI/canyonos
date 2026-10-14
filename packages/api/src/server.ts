// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { config } from '@core/env';
import { initLogger } from '@core/logger';

import { startApi } from './app';

initLogger();
void startApi({ host: config.app.host, port: config.app.port });
