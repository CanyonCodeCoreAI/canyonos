// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface AuthState {
  apiKey: string | null;
  login: (apiKey: string) => void;
  logout: () => void;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      apiKey: null,
      login: (apiKey) => set({ apiKey }),
      logout: () => set({ apiKey: null }),
    }),
    {
      name: 'cc-auth-storage',
      partialize: ({ apiKey }) => ({ apiKey }),
    }
  )
);

export const authActions = {
  apiKey: (): string | null => useAuthStore.getState().apiKey,
  isAuthenticated: (): boolean => useAuthStore.getState().apiKey !== null,
};

export const authSelectors = {
  signedIn: ({ apiKey }: AuthState): boolean => apiKey !== null,
};
