import type { AuthToken } from '@canyonos/api/auth';

import { apiCall, forgePublicApi } from '@/api';
import { useAuthStore } from '@/modules/auth/auth.store';
import { webEnv } from '@/modules/core/lib/env';

export const isCanyonOsLocalMode = webEnv.canyonos.isLocalMode;

/**
 * The single operator of a local install.
 *
 * `.invalid` is reserved by RFC 2606, so this address can never reach a real mailbox — a local
 * install signs in with it rather than mailing anyone a code.
 */
export const CANYONOS_ADMIN_EMAIL = 'admin@canyonos.invalid';

/** The code the API accepts for the local admin in place of a mailed one. */
export const CANYONOS_BYPASS_CODE = '111111';

/**
 * Open the local session.
 *
 * Failures are left to throw: the root guard turns them into the /login fallback, which is the one
 * place that decides what a reader sees when the box cannot sign itself in.
 */
export async function signInAsCanyonOsAdmin(): Promise<void> {
  const session = await apiCall<AuthToken>(() =>
    forgePublicApi.auth.verify.post({ email: CANYONOS_ADMIN_EMAIL, code: CANYONOS_BYPASS_CODE })
  );
  useAuthStore.getState().login(session.user, session.token);
}
