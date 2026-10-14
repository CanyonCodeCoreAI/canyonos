// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { edenTreaty } from '@elysiajs/eden';

import type { ForgeApi } from '@api/app';
import { config } from '@core/env';

export const createApi = (): ReturnType<typeof edenTreaty<ForgeApi>> =>
  edenTreaty<ForgeApi>(config.app.apiUrl);
