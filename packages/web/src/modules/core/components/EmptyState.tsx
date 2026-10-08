import { useId } from 'react';
import type { ReactNode } from 'react';

import { cn } from '@repo/ui/utils';

const UPPER_MARK =
  'M135.5 232Q164.46 232 187.28 218.2Q210.09 204.4 222.8 180.09Q235.5 155.77 235.5 125.44Q235.5 97.57 225.66 75.72Q215.83 53.86 197.25 39.65L160.91 80.36Q183.31 98.12 183.31 122.16Q183.31 142.38 170.34 154.68Q157.36 166.97 135.5 166.97Q113.64 166.97 100.66 154.68Q87.69 142.38 87.69 122.16Q87.69 98.12 110.09 80.36L73.75 39.65Q55.17 53.86 45.34 75.72Q35.5 97.57 35.5 125.44Q35.5 155.77 48.2 180.09Q60.91 204.4 83.72 218.2Q106.54 232 135.5 232Z';

const LOWER_MARK =
  'M135.5 116Q164.46 116 187.28 129.8Q210.09 143.6 222.8 167.91Q235.5 192.23 235.5 222.56Q235.5 250.43 225.66 272.28Q215.83 294.14 197.25 308.35L160.91 267.64Q183.31 249.88 183.31 225.84Q183.31 205.62 170.34 193.32Q157.36 181.03 135.5 181.03Q113.64 181.03 100.66 193.32Q87.69 205.62 87.69 225.84Q87.69 249.88 110.09 267.64L73.75 308.35Q55.17 294.14 45.34 272.28Q35.5 250.43 35.5 222.56Q35.5 192.23 48.2 167.91Q60.91 143.6 83.72 129.8Q106.54 116 135.5 116Z';

function Shimmer() {
  const id = useId();
  return (
    <>
      <defs>
        <clipPath id={`${id}-clip`}>
          <path d={UPPER_MARK} />
          <path d={LOWER_MARK} />
        </clipPath>
        <linearGradient id={`${id}-band`} x1="0" y1="0" x2="1" y2="0.4">
          <stop offset="0.3" stopColor="var(--background)" stopOpacity="0" />
          <stop offset="0.5" stopColor="var(--background)" stopOpacity="0.6" />
          <stop offset="0.7" stopColor="var(--background)" stopOpacity="0" />
        </linearGradient>
      </defs>
      <g clipPath={`url(#${id}-clip)`}>
        <rect
          width="271"
          height="348"
          fill={`url(#${id}-band)`}
          className="animate-shimmer [transform-box:fill-box] motion-reduce:animate-none"
        />
      </g>
    </>
  );
}

// One size wherever it appears, matching the mark on the sign-in brand panel.
function Logo({ loading }: { loading: boolean }) {
  return (
    <svg
      viewBox="0 0 271 348"
      className="size-9 shrink-0 dark:opacity-40"
      data-loading={loading}
      data-testid="empty-state-logo"
      aria-hidden
    >
      <path className="fill-foreground" d={UPPER_MARK} />
      <path className="fill-[#21C768]" d={LOWER_MARK} />
      {loading ? <Shimmer /> : null}
    </svg>
  );
}

// Both grow to fill what their container leaves (a card column, the page), so the mark and
// message sit centred where the data would have been. `section` has less padding.
const SIZE_CLASS = {
  page: 'flex-1 gap-3 p-10',
  section: 'flex-1 gap-2 p-6',
} as const;

interface EmptyStateProps {
  children: ReactNode;
  size?: keyof typeof SIZE_CLASS;
  loading?: boolean;
  className?: string;
  test_id?: string;
}

export function EmptyState({
  children,
  size = 'page',
  loading = false,
  className,
  test_id = 'empty-state',
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        'text-muted-foreground flex flex-col items-center justify-center text-sm',
        SIZE_CLASS[size],
        className
      )}
      data-testid={test_id}
    >
      <Logo loading={loading} />
      {children}
    </div>
  );
}
