// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useForm } from 'react-hook-form';

import { LoginSchema } from '@canyonos/api/auth';
import type { AuthToken, LoginInput } from '@canyonos/api/auth';

import { apiCall, forgePublicApi } from '@/api';
import { profileQuery } from '@/modules/auth/auth.queries';
import { useAuthStore } from '@/modules/auth/auth.store';
import {
  AUTH_ERROR_ID,
  AuthField,
  AuthFormError,
  AuthSubmit,
  enterAt,
} from '@/modules/auth/components/AuthField';

export function LoginScreen() {
  const { redirect } = useSearch({ from: '/_brand/login' });
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const form = useForm<LoginInput>({ resolver: zodResolver(LoginSchema) });
  const login = useMutation({
    mutationFn: (input: LoginInput) =>
      apiCall<AuthToken>(() => forgePublicApi.auth.login.post(input)),
    onSuccess: ({ user, token }) => {
      queryClient.setQueryData(profileQuery(token).queryKey, user);
      useAuthStore.getState().login(user, token);
      void navigate({ href: redirect ?? '/' });
    },
    onError: () => form.setFocus('password', { shouldSelect: true }),
  });
  const { errors } = form.formState;

  return (
    <div>
      <header className={enterAt(0)}>
        <h1 className="text-foreground text-xl font-semibold tracking-tight">Welcome back</h1>
        <p className="text-muted-foreground mt-1 text-[13px]">Sign in to the CanyonOS dashboard.</p>
      </header>

      <form
        className="mt-6 flex flex-col gap-3.5"
        aria-label="Sign in"
        noValidate
        onSubmit={form.handleSubmit((input) => login.mutate(input))}
      >
        <AuthField
          id="auth-email"
          label="Email"
          type="email"
          autoComplete="email"
          autoFocus
          className={enterAt(1)}
          error={errors.email?.message}
          {...form.register('email')}
        />
        <AuthField
          id="auth-password"
          label="Password"
          type="password"
          autoComplete="current-password"
          className={enterAt(2)}
          error={errors.password?.message}
          describedBy={login.error ? AUTH_ERROR_ID : undefined}
          {...form.register('password')}
        />
        <AuthFormError error={login.error} />
        <AuthSubmit className={enterAt(3)} pending={login.isPending} pendingLabel="Signing in…">
          Sign in
        </AuthSubmit>
      </form>
    </div>
  );
}
