// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { Button } from '@repo/ui/shadcn/button';
import { cn } from '@repo/ui/utils';
import { answeredWith } from '@/api';
import { EmptyState } from '@/modules/core/components/EmptyState';

/** The API's words when it refused the token for a read (403), such as a write token on a GET. */
export function readRefusal(error: unknown): string | null {
  return answeredWith(error, 403) ? error.message : null;
}

interface QueryErrorProps {
  readonly error: unknown;
  readonly message: string;
  readonly onRetry: () => void;
  readonly className?: string;
  readonly test_id?: string;
  readonly retry_test_id?: string;
}

/**
 * A failed read. When the API refused the token (403, such as a write token on a read), its
 * message stands where the data would be, with no retry: the same token gets the same answer.
 */
export function QueryError({
  error,
  message,
  onRetry,
  className,
  test_id,
  retry_test_id,
}: QueryErrorProps) {
  const refusal = readRefusal(error);
  if (refusal !== null) {
    return (
      <EmptyState size="section" className={className} test_id="query-refused">
        <p role="status">{refusal}</p>
      </EmptyState>
    );
  }

  return (
    <div
      className={cn(
        'border-destructive/25 bg-destructive/5 flex flex-wrap items-center justify-between gap-3 rounded-lg border px-4 py-3',
        className
      )}
      role="alert"
      data-testid={test_id}
    >
      <p className="text-destructive text-sm">{message}</p>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={onRetry}
        data-testid={retry_test_id}
      >
        Retry
      </Button>
    </div>
  );
}
