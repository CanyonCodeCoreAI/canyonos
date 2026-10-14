// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { existsSync } from 'fs';
import { resolve } from 'path';

import { config as loadEnv } from 'dotenv';

const localEnv = resolve(import.meta.dirname, '.env.local');
const baseEnv = resolve(import.meta.dirname, '.env');
if (existsSync(localEnv)) loadEnv({ path: localEnv });
if (existsSync(baseEnv)) loadEnv({ path: baseEnv });

export const getWebServerPort = (): number => {
  const raw = process.env.VITE_WEB_PORT ?? process.env.WEB_PORT;
  const n = raw ? parseInt(raw, 10) : 5173;
  return Number.isFinite(n) ? n : 5173;
};
