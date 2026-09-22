import { Link } from '@tanstack/react-router';
import { shallowEqual, useSelector } from '@xstate/react';
import { ArrowRightIcon, TriangleAlertIcon } from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@repo/ui/shadcn/alert';
import { Button } from '@repo/ui/shadcn/button';
import { selectStopFailure } from '@/modules/deploy/deploy.machine';
import type { DeployStatusMachineActorRef } from '@/modules/deploy/deploy.machine';

// Terminal outcome of a teardown — not the failure view: nothing went wrong, the deployment is gone.
export function DeployStoppedScreen({ actorRef }: { actorRef: DeployStatusMachineActorRef }) {
  const { config, unverified } = useSelector(
    actorRef,
    (state) => ({ config: state.context.config, unverified: selectStopFailure(state) }),
    shallowEqual
  );

  // The machine only routes here after `loadDeploy` resolved, so the config is always present.
  if (!config) return null;

  return (
    <main
      className="flex min-h-0 flex-1 flex-col px-7 pt-6 pb-16"
      data-testid="deploy-stopped-screen"
    >
      <div className="mx-auto flex w-full max-w-[47.5rem] flex-col gap-6">
        <header className="flex flex-col gap-2">
          <h1 className="text-2xl font-semibold tracking-tight">Instances stopped</h1>
          <p className="text-muted-foreground text-sm">
            <span className="text-foreground font-medium">{config.project_name}</span> is no longer
            running on {config.name}. Its instances were terminated and the endpoint is gone.
          </p>
        </header>

        {unverified ? (
          <Alert variant="warning" data-testid="deploy-stopped-unverified">
            <TriangleAlertIcon aria-hidden />
            <AlertTitle>Some instances could not be confirmed terminated</AlertTitle>
            <AlertDescription className="flex flex-col gap-1">
              <p>
                The teardown finished, but not everything it was meant to release could be verified.
                Check the AWS console for leftover instances.
              </p>
              <p
                className="font-mono text-xs break-all"
                data-testid="deploy-stopped-unverified-reason"
              >
                {unverified}
              </p>
            </AlertDescription>
          </Alert>
        ) : null}

        <footer className="flex flex-wrap items-center justify-end gap-4">
          <Button asChild data-testid="deploy-stopped-redeploy">
            <Link to="/projects/$project_id/deploy" params={{ project_id: config.project_id }}>
              Deploy again
              <ArrowRightIcon aria-hidden />
            </Link>
          </Button>
        </footer>
      </div>
    </main>
  );
}
