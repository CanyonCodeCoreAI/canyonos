// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { CircleAlert, Loader2 } from 'lucide-react';
import type { ComponentProps, ReactNode } from 'react';

import { Button } from '@repo/ui/shadcn/button';
import { Input } from '@repo/ui/shadcn/input';
import { Label } from '@repo/ui/shadcn/label';
import { cn } from '@repo/ui/utils';

export const AUTH_ERROR_ID = 'auth-error';

const ENTER = 'animate-in fade-in-0 slide-in-from-bottom-1 fill-mode-both ease-snappy duration-300';
const ENTER_DELAY = [
  '[animation-delay:0ms]',
  '[animation-delay:50ms]',
  '[animation-delay:100ms]',
  '[animation-delay:150ms]',
  '[animation-delay:200ms]',
] as const;

/** Entrance for the nth block of an auth screen: a short cascade from the heading down to the button. */
export function enterAt(step: 0 | 1 | 2 | 3 | 4): string {
  return `${ENTER} ${ENTER_DELAY[step]}`;
}

interface AuthFieldProps extends Omit<ComponentProps<'input'>, 'id'> {
  readonly id: string;
  readonly label: string;
  readonly error?: string;
  /** Another element that also explains this field, such as the form-level error. */
  readonly describedBy?: string;
}

export function AuthField({ id, label, error, describedBy, className, ...input }: AuthFieldProps) {
  const errorId = `${id}-error`;
  const descriptions = [error ? errorId : undefined, describedBy].filter(Boolean).join(' ');

  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        data-testid={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={descriptions || undefined}
        className="focus-visible:border-primary focus-visible:shadow-focus-ring ease-snappy shadow-xs duration-150"
        {...input}
      />
      <FieldError id={errorId} message={error} />
    </div>
  );
}

function FieldError({ id, message }: { readonly id: string; readonly message?: string }) {
  if (!message) return null;

  return (
    <p id={id} data-testid={id} className="animate-notice-in text-destructive text-xs">
      {message}
    </p>
  );
}

/** The request-level failure, announced and linked to the field it concerns. */
export function AuthFormError({ error }: { readonly error: Error | null }) {
  if (!error) return null;

  return (
    <div
      id={AUTH_ERROR_ID}
      role="alert"
      data-testid={AUTH_ERROR_ID}
      className="animate-notice-in border-destructive/30 bg-destructive/5 text-destructive flex items-start gap-2 rounded-md border px-3 py-2 text-[13px]"
    >
      <CircleAlert className="mt-px size-3.5 shrink-0" aria-hidden />
      {error.message}
    </div>
  );
}

interface AuthSubmitProps {
  readonly pending: boolean;
  readonly pendingLabel: string;
  readonly className?: string;
  readonly children: ReactNode;
}

export function AuthSubmit({ pending, pendingLabel, className, children }: AuthSubmitProps) {
  return (
    <Button
      type="submit"
      className={cn('mt-1 w-full rounded-md disabled:opacity-100', className)}
      disabled={pending}
      aria-busy={pending}
      data-testid="auth-submit"
    >
      <SubmitLabel pending={pending} pendingLabel={pendingLabel}>
        {children}
      </SubmitLabel>
    </Button>
  );
}

function SubmitLabel({ pending, pendingLabel, children }: Omit<AuthSubmitProps, 'className'>) {
  if (!pending) return children;

  return (
    <>
      <Loader2 className="animate-spin [animation-duration:600ms]" aria-hidden />
      {pendingLabel}
    </>
  );
}
