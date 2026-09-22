import { CircleHelp } from 'lucide-react';
import type { ReactNode } from 'react';

import { CanyonBrandPanel } from '@/modules/auth/components/CanyonBrandPanel';
import type { BrandCopy } from '@/modules/auth/components/CanyonBrandPanel';

export function AuthLayout({ brand, children }: { brand: BrandCopy; children: ReactNode }) {
  return (
    <main className="bg-background relative min-h-screen w-full">
      <CanyonBrandPanel {...brand} />

      <section className="relative z-[2] ml-auto flex h-screen w-full flex-col lg:w-[30%]">
        <div className="flex justify-end px-10 pt-7">
          <a
            href="#"
            className="text-muted-foreground hover:text-brand-deep inline-flex items-center gap-1.5 text-sm font-medium transition-colors"
          >
            <CircleHelp className="size-3.5" />
            Need help?
          </a>
        </div>

        <div className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center px-8 py-6">
          {children}
        </div>

        <footer className="text-placeholder flex items-center justify-between px-12 pb-7 text-xs">
          <span>© 2026 Canyon Code</span>
          <div className="flex gap-4">
            <a href="#" className="hover:text-muted-foreground transition-colors">
              Privacy
            </a>
            <a href="#" className="hover:text-muted-foreground transition-colors">
              Terms
            </a>
          </div>
        </footer>
      </section>
    </main>
  );
}
