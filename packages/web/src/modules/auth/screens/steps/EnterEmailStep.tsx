import { useSelector } from '@xstate/react';
import { Mail } from 'lucide-react';

import { Button } from '@repo/ui/shadcn/button';
import { Input } from '@repo/ui/shadcn/input';
import { Label } from '@repo/ui/shadcn/label';
import type { AuthMachineActorRef } from '@/modules/auth/auth.machine';

export function EnterEmailStep({ actorRef }: { actorRef: AuthMachineActorRef }) {
  const isLoading = useSelector(actorRef, (state) => state.hasTag('loading'));
  const error = useSelector(actorRef, (state) => state.context.error);

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const email = new FormData(event.currentTarget).get('email');
    actorRef.send({ type: 'SUBMIT_EMAIL', email: typeof email === 'string' ? email : '' });
  };

  return (
    <div>
      <h2 className="text-foreground mb-2 text-3xl font-semibold tracking-[-0.015em]">
        Welcome back
      </h2>
      <p className="text-muted-foreground mb-8 text-sm">Sign in to your CanyonOS workspace.</p>

      <form onSubmit={handleSubmit} noValidate>
        <Label
          htmlFor="email"
          className="text-secondary-foreground mb-2 block text-xs font-semibold"
        >
          Work email
        </Label>
        <Input
          id="email"
          name="email"
          type="email"
          autoFocus
          autoComplete="email"
          placeholder="you@company.com"
          disabled={isLoading}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? 'auth-error' : undefined}
          data-testid="auth-email-input"
        />
        <div className="mt-1.5 mb-2 min-h-4">
          {error && (
            <span id="auth-error" className="text-destructive text-xs">
              {error}
            </span>
          )}
        </div>

        <Button
          type="submit"
          className="h-12 w-full"
          disabled={isLoading}
          data-testid="auth-email-submit"
        >
          {isLoading ? 'Sending…' : 'Send login code'}
        </Button>
      </form>

      <p className="text-muted-foreground mt-3.5 flex items-start gap-2 text-xs leading-relaxed">
        <Mail className="text-primary mt-px size-4 shrink-0" />
        We&apos;ll email you a one-time code to sign in — no password needed.
      </p>

      <p className="text-muted-foreground mt-8 text-center text-sm">
        Don&apos;t have access yet?{' '}
        <a href="#" className="text-brand-deep font-semibold hover:underline">
          Request an invite
        </a>
      </p>
    </div>
  );
}
