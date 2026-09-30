import { Button } from '@repo/ui/shadcn/button';
import { cn } from '@repo/ui/utils';

interface QueryErrorProps {
  readonly message: string;
  readonly onRetry: () => void;
  readonly className?: string;
  readonly test_id?: string;
  readonly retry_test_id?: string;
}

export function QueryError({
  message,
  onRetry,
  className,
  test_id,
  retry_test_id,
}: QueryErrorProps) {
  return (
    <div
      className={cn(
        'border-destructive/25 bg-destructive/5 flex flex-wrap items-center justify-between gap-3 rounded-xl border px-4 py-3',
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
