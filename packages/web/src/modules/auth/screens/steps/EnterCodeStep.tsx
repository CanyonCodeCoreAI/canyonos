import { useSelector } from '@xstate/react';
import { Eye, EyeOff } from 'lucide-react';
import { useState } from 'react';

import { BackButton } from '@repo/ui/components/back-button';
import { Button } from '@repo/ui/shadcn/button';
import { InputOTP, InputOTPGroup, InputOTPSlot } from '@repo/ui/shadcn/input-otp';
import type { AuthMachineActorRef } from '@/modules/auth/auth.machine';

const OTP_LENGTH = 6;

export function EnterCodeStep({ actorRef }: { actorRef: AuthMachineActorRef }) {
  const isLoading = useSelector(actorRef, (state) => state.hasTag('loading'));
  const email = useSelector(actorRef, (state) => state.context.email);
  const error = useSelector(actorRef, (state) => state.context.error);
  const [isRevealed, setIsRevealed] = useState(false);

  const verify = (code: string) => actorRef.send({ type: 'SUBMIT_CODE', code });
  const goBack = () => actorRef.send({ type: 'GO_BACK' });
  const resend = () => actorRef.send({ type: 'RESEND_CODE' });

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const code = new FormData(event.currentTarget).get('code');
    verify(typeof code === 'string' ? code : '');
  };

  return (
    <div>
      <BackButton onClick={goBack} className="mb-6" />

      <h2 className="text-foreground mb-2 text-3xl font-semibold tracking-[-0.015em]">
        Enter your code
      </h2>
      <p className="text-muted-foreground mb-7 text-sm leading-relaxed">
        We sent a 6-digit code to
        <br />
        <span className="text-secondary-foreground font-semibold">{email}</span>
      </p>

      <form onSubmit={handleSubmit}>
        <InputOTP
          name="code"
          maxLength={OTP_LENGTH}
          autoFocus
          disabled={isLoading}
          onComplete={verify}
          data-testid="auth-code-input"
        >
          <InputOTPGroup>
            {Array.from({ length: OTP_LENGTH }, (_, index) => (
              <InputOTPSlot
                key={index}
                index={index}
                masked={!isRevealed}
                className="h-12 text-xl"
              />
            ))}
          </InputOTPGroup>
        </InputOTP>

        <div className="mt-2 mb-3.5 flex min-h-6 items-start justify-between gap-3">
          {error && <span className="text-destructive text-xs">{error}</span>}
          <button
            type="button"
            onClick={() => setIsRevealed((revealed) => !revealed)}
            // Keep the OTP field focused so a mouse user can carry on typing.
            onMouseDown={(event) => event.preventDefault()}
            aria-pressed={isRevealed}
            className="text-muted-foreground hover:text-foreground -my-1 ml-auto flex items-center gap-1 py-1 text-xs font-medium transition-colors"
            data-testid="auth-code-reveal-toggle"
          >
            {isRevealed ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
            {isRevealed ? 'Hide code' : 'Show code'}
          </button>
        </div>

        <Button
          type="submit"
          className="h-12 w-full"
          disabled={isLoading}
          data-testid="auth-code-submit"
        >
          {isLoading ? 'Verifying…' : 'Verify & continue'}
        </Button>
      </form>

      <p className="text-muted-foreground mt-4 text-center text-sm">
        Didn&apos;t get it?{' '}
        <button
          type="button"
          onClick={resend}
          className="text-brand-deep font-semibold hover:underline"
        >
          Resend code
        </button>
      </p>
    </div>
  );
}
