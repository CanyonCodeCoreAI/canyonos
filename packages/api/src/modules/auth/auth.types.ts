// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';

export const AuthStatusSchema = z.object({ api_key_required: z.boolean() });
export type AuthStatus = z.infer<typeof AuthStatusSchema>;

export const AuthCheckSchema = z.object({ ok: z.literal(true) });
export type AuthCheck = z.infer<typeof AuthCheckSchema>;
