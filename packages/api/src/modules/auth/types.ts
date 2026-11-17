// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';

/** Every scope a CanyonOS token carries: `query` for a workflow, `read` and `write` for the API. */
export const SCOPES = ['query', 'read', 'write'] as const;
export type Scope = (typeof SCOPES)[number];

export const API_SCOPES = ['read', 'write'] as const;
export type ApiScope = (typeof API_SCOPES)[number];

// packages/core/canyonos_core/auth.py and packages/cli/canyonos/auth.py hold the same two values.
export const TOKEN_ISSUER = 'canyonos';
export const API_AUDIENCE = 'canyonos-api';
// How far apart a signer's clock and this API's may be for `exp`; the endpoint gives PyJWT the
// same leeway (CLOCK_LEEWAY_SECONDS in packages/core/canyonos_core/auth.py), and neither checks
// `iat`.
export const CLOCK_TOLERANCE_SECONDS = 60;

export const AuthStatusSchema = z.object({ disabled: z.boolean() });
export type AuthStatus = z.infer<typeof AuthStatusSchema>;

export const TokenInfoSchema = z.object({
  scope: z.enum(SCOPES),
  expires_at: z.string().nullable(),
});
export type TokenInfo = z.infer<typeof TokenInfoSchema>;
