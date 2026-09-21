import { assign, fromPromise, setup } from 'xstate';
import type { ActorRefFrom } from 'xstate';

import { CompanyNameSchema, CompanySelectionSchema } from '@cc-forge/api/onboarding';
import type { User } from '@cc-forge/api/auth';
import type { Company } from '@cc-forge/api/companies';

import { apiCall, forgeAuthApi } from '@/api';
import { authActions, useAuthStore } from '@/modules/auth/auth.store';
import { router } from '@/modules/core/lib/router';

export interface OnboardingContext {
  companies: Company[];
  companyId: string | null;
  companyName: string | null;
  error: string | null;
}

export type OnboardingEvent =
  | { type: 'JOIN'; company_id: string }
  | { type: 'CREATE'; company_name: string }
  | { type: 'GO_CREATE' }
  | { type: 'GO_SELECT' }
  | { type: 'GO_BACK' };

const errorMessage = (error: unknown): string =>
  error instanceof Error && error.message
    ? error.message
    : 'Something went wrong. Please try again.';

export const onboardingMachine = setup({
  types: {
    context: {} as OnboardingContext,
    events: {} as OnboardingEvent,
  },
  actors: {
    loadCompanies: fromPromise<Company[]>(() =>
      apiCall<Company[]>(() => forgeAuthApi.companies.get())
    ),
    joinCompany: fromPromise<User, string>(({ input }) =>
      apiCall<User>(() => forgeAuthApi.onboarding.join.post({ company_id: input }))
    ),
    createCompany: fromPromise<User, string>(({ input }) =>
      apiCall<User>(() => forgeAuthApi.onboarding.create.post({ company_name: input }))
    ),
  },
  guards: {
    isValidJoin: ({ event }) =>
      event.type === 'JOIN' &&
      CompanySelectionSchema.safeParse({ company_id: event.company_id }).success,
    isValidCreate: ({ event }) =>
      event.type === 'CREATE' &&
      CompanyNameSchema.safeParse({ company_name: event.company_name }).success,
  },
}).createMachine({
  id: 'onboarding',
  initial: 'loading',
  context: { companies: [], companyId: null, companyName: null, error: null },
  states: {
    loading: {
      tags: ['loading'],
      invoke: {
        src: 'loadCompanies',
        onDone: {
          target: 'select',
          actions: assign({ companies: ({ event }) => event.output }),
        },
        onError: { target: 'select', actions: assign({ companies: [] }) },
      },
    },
    select: {
      on: {
        JOIN: [
          {
            guard: 'isValidJoin',
            target: 'joining',
            actions: assign({ companyId: ({ event }) => event.company_id, error: null }),
          },
          { actions: assign({ error: 'Please select a company.' }) },
        ],
        GO_CREATE: { target: 'create', actions: assign({ error: null }) },
        GO_BACK: '#onboarding.cancelled',
      },
    },
    create: {
      on: {
        CREATE: [
          {
            guard: 'isValidCreate',
            target: 'creating',
            actions: assign({ companyName: ({ event }) => event.company_name, error: null }),
          },
          { actions: assign({ error: 'Please enter a company name.' }) },
        ],
        GO_SELECT: { target: 'select', actions: assign({ error: null }) },
        GO_BACK: '#onboarding.cancelled',
      },
    },
    joining: {
      tags: ['loading'],
      invoke: {
        src: 'joinCompany',
        input: ({ context }) => context.companyId!,
        onDone: {
          target: 'done',
          actions: ({ event }) => authActions.setUser(event.output),
        },
        onError: {
          target: 'select',
          actions: assign({ error: ({ event }) => errorMessage(event.error) }),
        },
      },
    },
    creating: {
      tags: ['loading'],
      invoke: {
        src: 'createCompany',
        input: ({ context }) => context.companyName!,
        onDone: {
          target: 'done',
          actions: ({ event }) => authActions.setUser(event.output),
        },
        onError: {
          target: 'create',
          actions: assign({ error: ({ event }) => errorMessage(event.error) }),
        },
      },
    },
    done: {
      type: 'final',
      entry: () => void router.navigate({ to: '/' }),
    },
    cancelled: {
      type: 'final',
      entry: () => {
        useAuthStore.getState().logout();
        void router.navigate({ to: '/login' });
      },
    },
  },
});

export type OnboardingMachineActorRef = ActorRefFrom<typeof onboardingMachine>;
