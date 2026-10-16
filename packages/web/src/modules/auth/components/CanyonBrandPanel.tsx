// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

export interface BrandCopy {
  eyebrow: string;
  title: string;
  description: string;
  footnote: string;
}

export function CanyonBrandPanel({ eyebrow, title, description, footnote }: BrandCopy) {
  return (
    <section
      className="relative hidden w-[55%] shrink-0 flex-col justify-between overflow-hidden p-12 lg:flex xl:p-16"
      aria-hidden
    >
      <img src="/canyon-bg.jpg" alt="" className="absolute inset-0 size-full object-cover" />
      <div className="absolute inset-0 bg-linear-to-t from-[#06140c]/90 via-[#06140c]/35 to-[#06140c]/30" />

      <div className="relative flex items-center gap-2.5">
        <img src="/cc-favicon.svg" alt="" className="size-7 shrink-0" />
        <span className="text-sm font-semibold tracking-tight text-white">
          Canyon<span className="font-normal text-white/70"> Code</span>
        </span>
      </div>

      <div className="relative max-w-md">
        <span className="text-brand-mint mb-4 inline-flex items-center gap-2 font-mono text-[0.6875rem] font-medium tracking-[0.18em] uppercase">
          <span className="bg-brand-mint h-px w-5" />
          {eyebrow}
        </span>
        <h2 className="mb-3 text-2xl leading-[1.2] font-semibold tracking-tight text-balance text-white xl:text-3xl">
          {title}
        </h2>
        <p className="mb-4 max-w-sm text-sm leading-relaxed text-pretty text-white/75">
          {description}
        </p>
        <p className="flex items-center gap-2 text-[13px] font-medium text-white">
          <span className="bg-brand-bright size-1.5 rounded-full" />
          {footnote}
        </p>
      </div>
    </section>
  );
}
