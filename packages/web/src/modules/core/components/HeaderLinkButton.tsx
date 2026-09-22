import { createLink } from '@tanstack/react-router';
import { forwardRef } from 'react';
import type { LucideIcon } from 'lucide-react';
import type { AnchorHTMLAttributes } from 'react';

import { Button } from '@repo/ui/shadcn/button';

interface HeaderLinkButtonBaseProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
  readonly icon: LucideIcon;
  readonly label: string;
  readonly iconClassName?: string;
}

// The visual shell: a small outline button wrapping an anchor with a leading icon + label. Wrapped
// with `createLink` below so callers get fully type-safe router props (to/params/search) for free.
const HeaderLinkButtonBase = forwardRef<HTMLAnchorElement, HeaderLinkButtonBaseProps>(
  function HeaderLinkButtonBase({ icon: Icon, label, iconClassName, ...props }, ref) {
    return (
      <Button asChild variant="outline" size="sm">
        <a ref={ref} {...props}>
          <Icon className={iconClassName} aria-hidden />
          {label}
        </a>
      </Button>
    );
  }
);

/** Shared header-slot button: a typed router link styled as a small outline button with an icon. */
export const HeaderLinkButton = createLink(HeaderLinkButtonBase);
