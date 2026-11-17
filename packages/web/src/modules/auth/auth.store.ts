// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

import { isTokenExpired } from './token';

export interface ApiTokens {
  readToken: string | null;
  writeToken: string | null;
}

interface AuthState extends ApiTokens {
  login: (tokens: ApiTokens) => void;
  logout: () => void;
}

const SIGNED_OUT: ApiTokens = { readToken: null, writeToken: null };

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      ...SIGNED_OUT,
      login: ({ readToken, writeToken }) => set({ readToken, writeToken }),
      logout: () => set(SIGNED_OUT),
    }),
    {
      name: 'cc-auth-storage',
      partialize: ({ readToken, writeToken }) => ({ readToken, writeToken }),
    }
  )
);

const READ_METHODS = new Set(['GET', 'HEAD']);

function heldTokens({ readToken, writeToken }: ApiTokens): string[] {
  return [readToken, writeToken].filter((token): token is string => token !== null);
}

export const authActions = {
  /**
   * The token a request with this method needs; the other one when it is not held, so the
   * person reads the API's refusal rather than a request that silently never left.
   */
  tokenFor(method: string | undefined): string | null {
    const { readToken, writeToken } = useAuthStore.getState();
    if (READ_METHODS.has((method ?? 'GET').toUpperCase())) return readToken ?? writeToken;
    return writeToken ?? readToken;
  },
  heldTokens(): string[] {
    return heldTokens(useAuthStore.getState());
  },
  isAuthenticated(): boolean {
    const tokens = heldTokens(useAuthStore.getState());
    return tokens.length > 0 && tokens.every((token) => !isTokenExpired(token));
  },
};

export const authSelectors = {
  /** "read", "write" or "read and write": which of the two tokens this browser holds. */
  heldScopes: ({ readToken, writeToken }: AuthState): string =>
    [readToken ? 'read' : null, writeToken ? 'write' : null].filter(Boolean).join(' and '),
};
