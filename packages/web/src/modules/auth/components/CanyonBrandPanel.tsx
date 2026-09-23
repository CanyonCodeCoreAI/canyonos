export interface BrandCopy {
  eyebrow: string;
  title: string;
  description: string;
  footnote: string;
}

export function CanyonBrandPanel({ eyebrow, title, description, footnote }: BrandCopy) {
  return (
    <section
      className="absolute inset-y-0 left-0 hidden w-[70%] flex-col justify-between overflow-hidden p-12 lg:flex"
      aria-hidden
    >
      <img
        src="/canyon-bg.jpg"
        alt=""
        className="absolute inset-0 z-0 h-full w-full object-cover"
      />
      <div
        className="absolute inset-0 z-[1]"
        style={{
          background:
            'linear-gradient(165deg, rgba(11,42,26,0.86) 0%, rgba(15,58,35,0.72) 45%, rgba(21,82,49,0.55) 100%)',
        }}
      />

      <div className="relative z-[2] flex items-center gap-3">
        <img src="/cc-favicon.svg" alt="" className="size-9 shrink-0" />
        <span className="text-lg font-semibold tracking-tight text-white">
          Canyon<span className="font-normal opacity-80"> Code</span>
        </span>
      </div>

      <div className="relative z-[2] max-w-md">
        <span className="text-brand-mint mb-5 inline-flex items-center gap-2 font-mono text-xs font-medium tracking-[0.2em] uppercase">
          <span className="bg-brand-mint h-px w-6" />
          {eyebrow}
        </span>
        <h1 className="mb-5 text-5xl leading-tight font-semibold tracking-tight text-balance text-white">
          {title}
        </h1>
        <p className="mb-6 text-base leading-relaxed text-white/85">{description}</p>
        <p className="flex items-center gap-2.5 text-lg font-semibold text-white">
          <span className="bg-brand-bright size-2 rounded-full" />
          {footnote}
        </p>
      </div>
    </section>
  );
}
