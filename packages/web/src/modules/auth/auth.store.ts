import { create } from 'zustand';
import { persist } from 'zustand/middleware';

import type { User } from '@cc-forge/api/auth';

import { isTokenExpired } from './token';

interface AuthState {
  user: User | null;
  token: string | null;

  // actions
  login: (user: User, token: string) => void;
  logout: () => void;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      // initial state
      user: null,
      token: null,

      login: (user, token) => {
        set({
          user,
          token,
        });
      },

      logout: () => {
        set({
          user: null,
          token: null,
        });
      },
    }),
    {
      name: 'cc-auth-storage',
      partialize: (state) => ({
        user: state.user,
        token: state.token,
      }),
    }
  )
);

export const authActions = {
  getToken(): string | null {
    return useAuthStore.getState().token;
  },
  getUser(): User | null {
    return useAuthStore.getState().user;
  },
  isAuthenticated(): boolean {
    const token = useAuthStore.getState().token;
    return !!token && !isTokenExpired(token);
  },
  setUser(user: User) {
    useAuthStore.setState({ user });
  },
};

export const authStoreState = () => useAuthStore.getState();

/**
 * Selectors for optimal re-renders
 */
export const authSelectors = {
  isAuthenticated: (state: AuthState) => Boolean(state.token && state.user),
  user: (state: AuthState) => state.user,
  token: (state: AuthState) => state.token,
};
