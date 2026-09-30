import { InfoIcon, TriangleAlertIcon } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { ComponentProps, ReactNode } from 'react';

import { cn } from '../lib/utils';
import { Alert, AlertDescription, AlertTitle } from '../shadcn/alert';

export type NoticeVariant = 'default' | 'warning' | 'destructive';

const VARIANT_ICON: Record<NoticeVariant, LucideIcon> = {
  default: InfoIcon,
  warning: TriangleAlertIcon,
  destructive: TriangleAlertIcon,
};

export interface NoticeProps extends Omit<ComponentProps<'div'>, 'title'> {
  variant?: NoticeVariant;
  title: ReactNode;
  children: ReactNode;
}

export function Notice({ variant = 'warning', title, className, children, ...props }: NoticeProps) {
  const Icon = VARIANT_ICON[variant];

  return (
    <Alert variant={variant} className={cn('animate-notice-in shrink-0', className)} {...props}>
      <Icon aria-hidden />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription className="flex flex-col gap-2">{children}</AlertDescription>
    </Alert>
  );
}

/** Mono detail inside a `Notice`: a path, an identifier, a raw error line. */
export function NoticeCode({ className, ...props }: ComponentProps<'span'>) {
  return (
    <span
      className={cn(
        'border-border/70 bg-background text-foreground rounded-md border px-1.5 py-0.5 font-mono text-xs',
        className
      )}
      {...props}
    />
  );
}
