import { createFileRoute, redirect, useNavigate } from '@tanstack/react-router';
import { z } from 'zod';

import { Button } from '@repo/ui/shadcn/button';
import { authActions, useAuthStore } from '@/modules/auth/auth.store';
import { AuthScreen } from '@/modules/auth/screens/AuthScreen';
import type { BrandCopy } from '@/modules/auth/components/CanyonBrandPanel';

// `local_error` is set by the root guard when a CanyonOS local install could not open its own
// session. It is the reason this screen shows a failure instead of the sign-in form, so the branch
// below reads it rather than the local-mode flag: a local reader who logs out still needs the form.
const loginSearchSchema = z.object({
  redirect: z.string().optional(),
  local_error: z.string().optional(),
});

const LOGIN_BRAND: BrandCopy = {
  eyebrow: 'The missing link',
  title: 'A gap between design and execution.',
  description:
    'Multi-agentic apps are built in model-building IDEs like LangGraph and ADK. They run on AI compute. Connecting the two — deciding how each component scales, under which policies, and within which governance, security and identity rules — is the hard part.',
  footnote: 'CanyonOS is that link.',
};

export const Route = createFileRoute('/_brand/login')({
  validateSearch: loginSearchSchema,
  beforeLoad: ({ search }) => {
    if (!authActions.isAuthenticated()) {
      useAuthStore.getState().logout();
      return;
    }
    if (search.redirect) throw redirect({ href: search.redirect });
    throw redirect({ to: '/' });
  },
  staticData: { brand: LOGIN_BRAND },
  component: LoginRoute,
});

function LoginRoute() {
  const { local_error } = Route.useSearch();

  if (local_error !== undefined) return <LocalSignInFailure message={local_error} />;
  return <AuthScreen />;
}

/**
 * What a CanyonOS local install shows when it could not sign itself in.
 *
 * There is no form to offer — the box owns the only account — so the screen reports why and hands
 * back the attempt. Retry navigates to where the guard was heading, which re-runs the guard and
 * re-attempts the sign-in: one sign-in path, driven by the reader rather than by a loop.
 */
function LocalSignInFailure({ message }: { readonly message: string }) {
  const { redirect: destination } = Route.useSearch();
  const navigate = useNavigate();

  return (
    <div className="flex flex-col gap-5" data-testid="canyonos-local-error">
      <div className="flex flex-col gap-2">
        <h1 className="text-foreground text-2xl font-bold tracking-tight">
          CanyonOS could not start
        </h1>
        <p className="text-muted-foreground text-sm leading-relaxed" role="alert">
          {message}
        </p>
      </div>
      <Button
        type="button"
        className="w-fit"
        data-testid="canyonos-local-retry"
        onClick={() => void navigate({ href: destination ?? '/' })}
      >
        Retry
      </Button>
    </div>
  );
}
