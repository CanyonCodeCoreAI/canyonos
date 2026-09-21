import type { DeploymentStatus } from '@cc-forge/api/deploy';

import { Badge } from '@repo/ui/shadcn/badge';
import { cn } from '@repo/ui/utils';
import { deploymentStatusLabel, isDeploymentActive } from '@/modules/deploy/deploy.lifecycle';

/**
 * A project's deploy state as one chip, shared by the projects overview rows and the project screen
 * so both spell the same state the same way. No deployment yet is a state, not missing data — that
 * absence is what "Not deployed" means.
 */
export function DeploymentStatusBadge({
  status,
  className,
  'data-testid': test_id,
}: {
  readonly status: DeploymentStatus | undefined;
  readonly className?: string;
  readonly 'data-testid'?: string;
}) {
  if (status === undefined) {
    return (
      <Badge
        variant="secondary"
        className={cn('shrink-0', className)}
        data-status="none"
        data-testid={test_id}
      >
        <span className="size-1.5 rounded-full bg-current" aria-hidden />
        Not deployed
      </Badge>
    );
  }

  // `stopped` is a finished outcome, not a failure.
  const variant =
    status === 'success' || status === 'stopped'
      ? 'complete'
      : status === 'failed'
        ? 'failed'
        : 'running';
  return (
    <Badge
      variant={variant}
      className={cn('shrink-0', className)}
      data-status={status}
      data-testid={test_id}
    >
      <span
        className={cn(
          'size-1.5 rounded-full bg-current',
          isDeploymentActive(status) && 'motion-safe:animate-pulse'
        )}
        aria-hidden
      />
      {deploymentStatusLabel(status)}
    </Badge>
  );
}
