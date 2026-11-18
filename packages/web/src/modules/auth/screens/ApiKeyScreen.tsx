// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useRouteContext, useSearch } from '@tanstack/react-router';
import { useForm, useWatch } from 'react-hook-form';
import { z } from 'zod';

import { checkApiKey } from '@/modules/auth/auth.sign-in';
import { useAuthStore } from '@/modules/auth/auth.store';
import {
  AUTH_ERROR_ID,
  AuthField,
  AuthFormError,
  AuthSubmit,
  enterAt,
} from '@/modules/auth/components/AuthField';

const SignInSchema = z.object({ apiKey: z.string().trim().min(1) });
type SignInInput = z.input<typeof SignInSchema>;
type SignIn = z.output<typeof SignInSchema>;

export function ApiKeyScreen() {
  const { redirect } = useSearch({ from: '/_brand/login' });
  const { linkError } = useRouteContext({ from: '/_brand/login' });
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const form = useForm<SignInInput, unknown, SignIn>({
    resolver: zodResolver(SignInSchema),
    defaultValues: { apiKey: '' },
  });
  const typed = useWatch({ control: form.control, name: 'apiKey' });
  const signIn = useMutation({
    mutationFn: async ({ apiKey }: SignIn) => {
      await checkApiKey(queryClient, apiKey);
      return apiKey;
    },
    onSuccess: (apiKey) => {
      useAuthStore.getState().login(apiKey);
      void navigate({ href: redirect ?? '/' });
    },
    onError: () => form.setFocus('apiKey', { shouldSelect: true }),
  });
  const error = signIn.isIdle ? linkError : signIn.error;

  return (
    <div>
      <header className={enterAt(0)}>
        <h1 className="text-foreground text-xl font-semibold tracking-tight">
          Sign in with the API key
        </h1>
        <p className="text-muted-foreground mt-1 text-[0.8125rem]">
          The key this machine runs CanyonOS with, set by <code>--api-key</code> on{' '}
          <code>canyonos deploy</code> or <code>canyonos serve</code>.
        </p>
      </header>

      <form
        className="mt-6 flex flex-col gap-3.5"
        aria-label="Sign in"
        noValidate
        onSubmit={form.handleSubmit((values) => signIn.mutate(values))}
      >
        <AuthField
          id="auth-api-key"
          label="API key"
          type="password"
          autoComplete="off"
          spellCheck={false}
          autoFocus
          className={enterAt(1)}
          help={<HelpLink />}
          describedBy={error ? AUTH_ERROR_ID : undefined}
          {...form.register('apiKey')}
        />
        <AuthFormError error={error} />
        <AuthSubmit
          className={enterAt(2)}
          pending={signIn.isPending}
          disabled={!typed.trim()}
          pendingLabel="Checking the key…"
        >
          Sign in
        </AuthSubmit>
      </form>
    </div>
  );
}

function HelpLink() {
  return (
    <>
      Or run <code className="font-mono">canyonos dashboard</code> on that machine to open this page
      signed in.
    </>
  );
}
