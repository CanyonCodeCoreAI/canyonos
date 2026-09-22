import { Fragment } from 'react';

import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbSeparator,
} from '@repo/ui/shadcn/breadcrumb';

interface BreadcrumbSegment {
  readonly id: string;
  readonly label: string;
}

export function BreadcrumbTrail({ segments }: { readonly segments: readonly BreadcrumbSegment[] }) {
  return (
    <Breadcrumb>
      <BreadcrumbList data-testid="app-breadcrumbs">
        {segments.map(({ id, label }, index) => (
          <Fragment key={id}>
            {index > 0 ? <BreadcrumbSeparator /> : null}
            <BreadcrumbItem>
              <span
                className={
                  index === segments.length - 1
                    ? 'text-foreground font-bold'
                    : 'text-muted-foreground font-normal'
                }
                aria-current={index === segments.length - 1 ? 'page' : undefined}
              >
                {label}
              </span>
            </BreadcrumbItem>
          </Fragment>
        ))}
      </BreadcrumbList>
    </Breadcrumb>
  );
}
