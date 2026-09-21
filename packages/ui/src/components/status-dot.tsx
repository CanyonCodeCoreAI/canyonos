import { cva } from 'class-variance-authority';
import type { VariantProps } from 'class-variance-authority';
import type * as React from 'react';

import type { RequestStatus } from '@cc-forge/api/core';

import { cn } from '../lib/utils';

export interface StatusAccent {
  readonly solid: string;
  readonly soft: string;
  readonly text: string;
}

// Single source of truth for status colour: the solid class drives the dot, the soft/text pair
// drives pill bodies. `running` keeps its pulse on the solid marker only.
export const STATUS_ACCENT: Readonly<Record<RequestStatus, StatusAccent>> = {
  ok: { solid: 'bg-primary', soft: 'bg-primary/10', text: 'text-primary' },
  running: {
    solid: 'bg-chart-3 motion-safe:animate-pulse',
    soft: 'bg-chart-3/10',
    text: 'text-chart-3',
  },
  error: { solid: 'bg-destructive', soft: 'bg-destructive/10', text: 'text-destructive' },
};

const statusDotVariants = cva('inline-block shrink-0 rounded-full', {
  variants: {
    status: {
      ok: STATUS_ACCENT.ok.solid,
      running: STATUS_ACCENT.running.solid,
      error: STATUS_ACCENT.error.solid,
    },
    size: {
      sm: 'size-2',
      md: 'size-[0.5625rem]',
    },
  },
  defaultVariants: { status: 'ok', size: 'sm' },
});

const STATUS_LABEL: Record<RequestStatus, string> = {
  ok: 'Healthy',
  running: 'Running',
  error: 'Failed',
};

interface StatusDotProps
  extends Omit<React.ComponentProps<'span'>, 'children'>,
    VariantProps<typeof statusDotVariants> {
  label?: string;
  // Set when an adjacent visible label already names the status (e.g. inside StatusPill), so the
  // dot is not announced redundantly. Standalone dots keep announcing by default.
  decorative?: boolean;
}

function StatusDot({
  className,
  status,
  size,
  label,
  decorative = false,
  ...props
}: StatusDotProps) {
  const accessibleLabel = label ?? STATUS_LABEL[status ?? 'ok'];
  const semantics = decorative
    ? { 'aria-hidden': true }
    : { role: 'img', 'aria-label': accessibleLabel, title: accessibleLabel };
  return (
    <span
      className={cn(statusDotVariants({ status, size }), className)}
      {...semantics}
      {...props}
    />
  );
}

export { StatusDot, statusDotVariants };
export type { StatusDotProps };
