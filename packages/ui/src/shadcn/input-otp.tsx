import { OTPInput, OTPInputContext } from 'input-otp';
import { Minus } from 'lucide-react';
import * as React from 'react';

import { cn } from '../lib/utils';

function InputOTP({
  className,
  containerClassName,
  ref,
  ...props
}: React.ComponentProps<typeof OTPInput>) {
  return (
    <OTPInput
      ref={ref}
      containerClassName={cn(
        'flex items-center gap-2 has-[:disabled]:opacity-50',
        containerClassName
      )}
      className={cn('disabled:cursor-not-allowed', className)}
      {...props}
    />
  );
}

function InputOTPGroup({ className, ...props }: React.ComponentProps<'div'>) {
  return <div className={cn('flex w-full items-center gap-2.5', className)} {...props} />;
}

function InputOTPSlot({
  index,
  masked,
  className,
  ...props
}: React.ComponentProps<'div'> & { index: number; masked?: boolean }) {
  const inputOTPContext = React.use(OTPInputContext);
  const slot = inputOTPContext.slots[index];

  return (
    <div
      data-active={slot?.isActive || undefined}
      className={cn(
        'border-input bg-background text-foreground relative flex aspect-square flex-1 items-center justify-center rounded-md border text-xl font-semibold transition-[color,box-shadow,border-color]',
        className
      )}
      {...props}
    >
      {masked && slot?.char ? (
        // `*` sits near cap-height, so centering the line box still leaves the ink high.
        <span aria-hidden className="translate-y-[0.2em] leading-none">
          *
        </span>
      ) : (
        slot?.char
      )}
      {slot?.hasFakeCaret && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="animate-caret-blink bg-foreground h-5 w-px duration-1000" />
        </div>
      )}
    </div>
  );
}

function InputOTPSeparator({ ...props }: React.ComponentProps<'div'>) {
  return (
    <div aria-hidden {...props}>
      <Minus className="text-muted-foreground" />
    </div>
  );
}

export { InputOTP, InputOTPGroup, InputOTPSlot, InputOTPSeparator };
