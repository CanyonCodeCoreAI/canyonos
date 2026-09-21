import { assign, fromPromise, setup } from 'xstate';
import { z } from 'zod';
import type { ActorRefFrom } from 'xstate';

import { UserStatusEnum } from '@cc-forge/api/auth';
import type { AuthToken, User } from '@cc-forge/api/auth';

import { apiCall, forgePublicApi } from '@/api';
import { useAuthStore } from '@/modules/auth/auth.store';
import { router } from '@/modules/core/lib/router';

const emailSchema = z.string().trim().email();

export interface AuthContext {
  email: string;
  error: string | null;
  redirectTo: '/' | '/onboarding' | null;
}

export type AuthEvent =
  | { type: 'SUBMIT_EMAIL'; email: string }
  | { type: 'SUBMIT_CODE'; code: string }
  | { type: 'RESEND_CODE' }
  | { type: 'GO_BACK' };

const errorMessage = (error: unknown): string =>
  error instanceof Error && error.message
    ? error.message
    : 'Something went wrong. Please try again.';

// ACTIVE users have finished onboarding and belong in the app shell; everyone
// else still needs onboarding. Deterministic, so it lives in the machine.
const redirectForStatus = (status: User['status']): '/' | '/onboarding' =>
  status === UserStatusEnum.ACTIVE ? '/' : '/onboarding';

export const authMachine = setup({
  types: {
    context: {} as AuthContext,
    events: {} as AuthEvent,
  },
  actors: {
    requestChallenge: fromPromise<{ ok: true }, { email: string }>(({ input }) =>
      apiCall(() => forgePublicApi.auth.challenge.post({ email: input.email }))
    ),
    verifyChallenge: fromPromise<AuthToken, { email: string; code: string }>(({ input }) =>
      apiCall(() => forgePublicApi.auth.verify.post({ email: input.email, code: input.code }))
    ),
  },
  guards: {
    isValidEmail: ({ event }) =>
      event.type === 'SUBMIT_EMAIL' && emailSchema.safeParse(event.email).success,
  },
}).createMachine({
  id: 'auth',
  initial: 'email',
  context: { email: '', error: null, redirectTo: null },
  states: {
    email: {
      initial: 'idle',
      entry: assign({ error: null }),
      states: {
        idle: {
          on: {
            SUBMIT_EMAIL: [
              {
                guard: 'isValidEmail',
                target: 'submitting',
                actions: assign({ email: ({ event }) => event.email, error: null }),
              },
              { actions: assign({ error: 'Enter a valid email address.' }) },
            ],
          },
        },
        submitting: {
          tags: ['loading'],
          invoke: {
            src: 'requestChallenge',
            input: ({ context }) => ({ email: context.email }),
            onDone: '#auth.code',
            onError: {
              target: 'idle',
              actions: assign({ error: ({ event }) => errorMessage(event.error) }),
            },
          },
        },
      },
    },
    code: {
      initial: 'idle',
      entry: assign({ error: null }),
      states: {
        idle: {
          on: {
            SUBMIT_CODE: 'verifying',
            RESEND_CODE: '#auth.email.submitting',
            GO_BACK: '#auth.email',
          },
        },
        verifying: {
          tags: ['loading'],
          invoke: {
            src: 'verifyChallenge',
            input: ({ context, event }) => ({
              email: context.email,
              code: event.type === 'SUBMIT_CODE' ? event.code : '',
            }),
            onDone: {
              target: '#auth.redirecting',
              actions: [
                ({ event }) => useAuthStore.getState().login(event.output.user, event.output.token),
                assign({ redirectTo: ({ event }) => redirectForStatus(event.output.user.status) }),
              ],
            },
            onError: {
              target: 'idle',
              actions: assign({ error: ({ event }) => errorMessage(event.error) }),
            },
          },
        },
      },
    },
    redirecting: {
      type: 'final',
      entry: ({ context }) => {
        if (context.redirectTo) void router.navigate({ to: context.redirectTo });
      },
    },
  },
});

export type AuthMachineActorRef = ActorRefFrom<typeof authMachine>;
