// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useForm, useWatch } from 'react-hook-form';
import { z } from 'zod';
import type { QueryClient } from '@tanstack/react-query';
import type { ComponentProps } from 'react';

import type { ApiScope } from '@canyonos/api/auth';

import { tokenInfoQuery } from '@/modules/auth/auth.queries';
import { useAuthStore } from '@/modules/auth/auth.store';
import {
  AUTH_ERROR_ID,
  AuthField,
  AuthFormError,
  AuthSubmit,
  enterAt,
} from '@/modules/auth/components/AuthField';
import type { ApiTokens } from '@/modules/auth/auth.store';

const TOKEN_FIELDS = {
  read: { name: 'readToken', id: 'auth-read-token', label: 'Read token' },
  write: { name: 'writeToken', id: 'auth-write-token', label: 'Write token' },
} as const satisfies Record<ApiScope, { name: keyof ApiTokens; id: string; label: string }>;

const typedToken = z
  .string()
  .trim()
  .transform((token) => token || null);

const TokensSchema = z.object({ readToken: typedToken, writeToken: typedToken });
type TokensInput = z.input<typeof TokensSchema>;

/** A refusal of the token typed into one field, which the message names. */
class TokenFieldError extends Error {
  constructor(
    readonly scope: ApiScope,
    message: string
  ) {
    super(`${TOKEN_FIELDS[scope].label}: ${message}`);
  }
}

async function checkToken(queryClient: QueryClient, scope: ApiScope, token: string | null) {
  if (!token) return;
  const info = await queryClient.fetchQuery(tokenInfoQuery(token)).catch((error: unknown) => {
    throw new TokenFieldError(scope, error instanceof Error ? error.message : String(error));
  });
  if (info.scope !== scope) {
    throw new TokenFieldError(scope, `This is a ${info.scope} token, not a ${scope} token`);
  }
}

export function TokenScreen() {
  const { redirect } = useSearch({ from: '/_brand/login' });
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const form = useForm<TokensInput, unknown, ApiTokens>({
    resolver: zodResolver(TokensSchema),
    defaultValues: { readToken: '', writeToken: '' },
  });
  const typed = useWatch({ control: form.control, name: ['readToken', 'writeToken'] });
  const signIn = useMutation({
    mutationFn: async (tokens: ApiTokens) => {
      await checkToken(queryClient, 'read', tokens.readToken);
      await checkToken(queryClient, 'write', tokens.writeToken);
      return tokens;
    },
    onSuccess: (tokens) => {
      useAuthStore.getState().login(tokens);
      void navigate({ href: redirect ?? '/' });
    },
    onError: (error) => {
      if (!(error instanceof TokenFieldError)) return;
      form.setFocus(TOKEN_FIELDS[error.scope].name, { shouldSelect: true });
    },
  });
  const faultyScope = signIn.error instanceof TokenFieldError ? signIn.error.scope : null;

  return (
    <div>
      <header className={enterAt(0)}>
        <h1 className="text-foreground text-xl font-semibold tracking-tight">
          Sign in with API tokens
        </h1>
        <p className="text-muted-foreground mt-1 text-[0.8125rem]">
          Make them on the machine that runs CanyonOS. A read token shows the projects, a write
          token changes them; give both to do both.
        </p>
      </header>

      <form
        className="mt-6 flex flex-col gap-3.5"
        aria-label="Sign in"
        noValidate
        onSubmit={form.handleSubmit((tokens) => signIn.mutate(tokens))}
      >
        <TokenField
          scope="read"
          className={enterAt(1)}
          faultyScope={faultyScope}
          autoFocus
          {...form.register('readToken')}
        />
        <TokenField
          scope="write"
          className={enterAt(2)}
          faultyScope={faultyScope}
          {...form.register('writeToken')}
        />
        <AuthFormError error={signIn.error} />
        <AuthSubmit
          className={enterAt(3)}
          pending={signIn.isPending}
          disabled={typed.every((token) => !token?.trim())}
          pendingLabel="Checking tokens…"
        >
          Sign in
        </AuthSubmit>
      </form>
    </div>
  );
}

interface TokenFieldProps extends Omit<ComponentProps<typeof AuthField>, 'id' | 'label'> {
  readonly scope: ApiScope;
  readonly faultyScope: ApiScope | null;
}

function TokenField({ scope, faultyScope, ...input }: TokenFieldProps) {
  const { id, label } = TOKEN_FIELDS[scope];

  return (
    <AuthField
      id={id}
      label={label}
      type="password"
      autoComplete="off"
      spellCheck={false}
      help={<code className="font-mono">canyonos token create --scope {scope}</code>}
      describedBy={faultyScope === scope ? AUTH_ERROR_ID : undefined}
      {...input}
    />
  );
}
