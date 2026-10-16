// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { useForm } from 'react-hook-form';

import { RegisterSchema } from '@canyonos/api/auth';
import type { AuthToken, RegisterInput } from '@canyonos/api/auth';

import { apiCall, ApiResponseError, forgePublicApi } from '@/api';
import { authStatusQuery, profileQuery } from '@/modules/auth/auth.queries';
import { useAuthStore } from '@/modules/auth/auth.store';
import {
  AUTH_ERROR_ID,
  AuthField,
  AuthFormError,
  AuthSubmit,
  enterAt,
} from '@/modules/auth/components/AuthField';

const REGISTRATION_CLOSED = 'auth.registration_closed';

export function RegisterScreen() {
  const { redirect } = useSearch({ from: '/_brand/register' });
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const form = useForm<RegisterInput>({ resolver: zodResolver(RegisterSchema) });
  const register = useMutation({
    mutationFn: (input: RegisterInput) =>
      apiCall<AuthToken>(() => forgePublicApi.auth.register.post(input)),
    onSuccess: ({ user, token }) => {
      queryClient.setQueryData(profileQuery(token).queryKey, user);
      useAuthStore.getState().login(user, token);
      void queryClient.invalidateQueries(authStatusQuery);
      void navigate({ href: redirect ?? '/' });
    },
  });
  const { errors } = form.formState;

  return (
    <div>
      <header className={enterAt(0)}>
        <h1 className="text-foreground text-xl font-semibold tracking-tight">
          Create the first account
        </h1>
        <p className="text-muted-foreground mt-1 text-[13px]">
          This install has no accounts yet. The first one is yours.
        </p>
      </header>

      <form
        className="mt-6 flex flex-col gap-3.5"
        aria-label="Create the first account"
        noValidate
        onSubmit={form.handleSubmit((input) => register.mutate(input))}
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
          autoComplete="new-password"
          className={enterAt(2)}
          error={errors.password?.message}
          describedBy={register.error ? AUTH_ERROR_ID : undefined}
          {...form.register('password')}
        />
        <AuthField
          id="auth-password-confirmation"
          label="Confirm password"
          type="password"
          autoComplete="new-password"
          className={enterAt(3)}
          error={errors.password_confirmation?.message}
          {...form.register('password_confirmation')}
        />
        <AuthFormError error={register.error} />
        <SignInInstead error={register.error} redirect={redirect} />
        <AuthSubmit
          className={enterAt(4)}
          pending={register.isPending}
          pendingLabel="Creating account…"
        >
          Create account
        </AuthSubmit>
      </form>
    </div>
  );
}

/** Someone else created the first account while this form was open. */
function SignInInstead({
  error,
  redirect,
}: {
  readonly error: Error | null;
  readonly redirect?: string;
}) {
  if (!(error instanceof ApiResponseError) || error.code !== REGISTRATION_CLOSED) return null;

  return (
    <Link
      to="/login"
      search={{ redirect }}
      className="text-brand-deep -mt-1 self-start text-[13px] font-medium underline-offset-4 hover:underline"
      data-testid="auth-go-to-login"
    >
      Go to sign in
    </Link>
  );
}
