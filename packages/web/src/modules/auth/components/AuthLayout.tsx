// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import type { ReactNode } from 'react';

import { CanyonBrandPanel } from '@/modules/auth/components/CanyonBrandPanel';
import type { BrandCopy } from '@/modules/auth/components/CanyonBrandPanel';

export function AuthLayout({ brand, children }: { brand: BrandCopy; children: ReactNode }) {
  return (
    <main className="bg-background flex min-h-dvh w-full">
      <CanyonBrandPanel {...brand} />

      <section className="flex min-w-0 flex-1 flex-col px-6 py-6 sm:px-10 lg:px-16">
        <header className="flex items-center gap-2.5 lg:hidden">
          <img src="/cc-favicon-light.svg" alt="" className="size-6 shrink-0 dark:hidden" />
          <img src="/cc-favicon.svg" alt="" className="hidden size-6 shrink-0 dark:block" />
          <span className="text-foreground text-sm font-semibold tracking-tight">
            Canyon<span className="text-muted-foreground font-normal"> Code</span>
          </span>
        </header>

        <div className="mx-auto my-auto w-full max-w-[20rem] py-12">{children}</div>
      </section>
    </main>
  );
}
