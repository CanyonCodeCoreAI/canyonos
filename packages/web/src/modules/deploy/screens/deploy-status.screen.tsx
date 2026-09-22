import { Link } from '@tanstack/react-router';
import { useActorRef, useSelector } from '@xstate/react';
import { ArrowLeftIcon } from 'lucide-react';

import { Alert, AlertDescription } from '@repo/ui/shadcn/alert';
import { Button } from '@repo/ui/shadcn/button';
import { QueryError } from '@/modules/core/components/QueryError';
import { HeaderDockPortal } from '@/modules/core/navigation/header-dock';
import { DeploySkeleton } from '@/modules/deploy/components/deploy-skeleton';
import { deployStatusMachine, selectDeployScreen } from '@/modules/deploy/deploy.machine';
import { DeployCompleteScreen } from '@/modules/deploy/screens/deploy-complete.screen';
import { DeployProgressScreen } from '@/modules/deploy/screens/deploy-progress.screen';
import { DeployStoppedScreen } from '@/modules/deploy/screens/deploy-stopped.screen';
import type { DeployScreen, DeployStatusMachineActorRef } from '@/modules/deploy/deploy.machine';

interface DeployStatusScreenProps {
  readonly project_id: string;
  readonly deploy_id: string;
}

// Screens where the deploy has not settled yet.
const IN_FLIGHT_SCREENS = new Set<DeployScreen>(['loading', 'progress']);

function renderScreen(screen: DeployScreen, actorRef: DeployStatusMachineActorRef) {
  switch (screen) {
    case 'loading':
      return <DeploySkeleton />;
    case 'error':
      return (
        <QueryError
          message="Could not load this deployment."
          onRetry={() => actorRef.send({ type: 'RETRY' })}
          className="m-7"
          test_id="deploy-progress-error"
        />
      );
    case 'notFound':
      return (
        <Alert variant="destructive" className="m-7" data-testid="deploy-not-found">
          <AlertDescription>
            This deployment could not be found. It may have been removed.
          </AlertDescription>
        </Alert>
      );
    case 'progress':
      return <DeployProgressScreen actorRef={actorRef} />;
    case 'complete':
      return <DeployCompleteScreen actorRef={actorRef} />;
    case 'stopped':
      return <DeployStoppedScreen actorRef={actorRef} />;
  }
}

/**
 * Drives one deployment from the deploy-status machine. The machine owns the flow AND the data (it
 * loads the deploy config), so this component only selects which screen to show and hands the actor
 * down — the sub-screens read what they need via `useSelector`.
 * The success summary is only reachable by passing through the live `running` state.
 */
export function DeployStatusScreen({ project_id, deploy_id }: DeployStatusScreenProps) {
  const actorRef = useActorRef(deployStatusMachine, { input: { project_id, deploy_id } });
  const screen = useSelector(actorRef, selectDeployScreen);

  return (
    <>
      {IN_FLIGHT_SCREENS.has(screen) ? null : (
        <HeaderDockPortal>
          <Button asChild variant="outline" size="sm">
            <Link
              to="/projects/$project_id"
              params={{ project_id }}
              data-testid="header-back-to-project"
            >
              <ArrowLeftIcon aria-hidden />
              Back to project
            </Link>
          </Button>
        </HeaderDockPortal>
      )}
      {renderScreen(screen, actorRef)}
    </>
  );
}
