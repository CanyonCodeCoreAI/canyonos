// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import type { HTMLAttributes } from 'react';

import { cn } from '../lib/utils';

interface SectionLabelProps extends HTMLAttributes<HTMLElement> {
  as?: 'span' | 'h2' | 'h3';
}

export function SectionLabel({ as: Tag = 'span', className, ...props }: SectionLabelProps) {
  return (
    <Tag
      className={cn(
        'text-muted-foreground text-[0.6875rem] font-bold tracking-[0.07em] uppercase',
        className
      )}
      {...props}
    />
  );
}
