import { shallowEqual, useSelector } from '@xstate/react';
import { useState } from 'react';

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@repo/ui/shadcn/alert-dialog';
import { Button } from '@repo/ui/shadcn/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@repo/ui/shadcn/tooltip';
import { selectStopState } from '@/modules/deploy/deploy.machine';
import type { DeployStatusMachineActorRef } from '@/modules/deploy/deploy.machine';

/** Tears down a live deployment's instances. Irreversible, so only the dialog fires the request. */
export function DeployStopButton({ actorRef }: { actorRef: DeployStatusMachineActorRef }) {
  const [confirming, setConfirming] = useState(false);
  const { requesting, stopping, capability } = useSelector(actorRef, selectStopState, shallowEqual);
  const blocked = capability?.available === false;
  const busy = requesting || stopping;

  const button = (
    <Button
      variant="outline"
      size="sm"
      className="hover:border-destructive hover:bg-destructive hover:text-destructive-foreground"
      disabled={busy || blocked}
      data-testid="deploy-stop"
      onClick={() => {
        if (!blocked) setConfirming(true);
      }}
    >
      {stopping ? 'Stopping…' : 'Stop instances'}
    </Button>
  );

  return (
    <>
      {blocked && capability?.message ? (
        <TooltipProvider delayDuration={150}>
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="inline-flex" tabIndex={0} data-testid="deploy-stop-trigger">
                {button}
              </span>
            </TooltipTrigger>
            <TooltipContent side="bottom" align="end" data-testid="deploy-stop-tooltip">
              {capability.message}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      ) : (
        button
      )}

      <AlertDialog
        open={confirming}
        onOpenChange={(next) => {
          if (!next && busy) return;
          setConfirming(next);
        }}
      >
        <AlertDialogContent data-testid="deploy-stop-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>Stop instances</AlertDialogTitle>
            <AlertDialogDescription>
              This terminates the instances running this deployment. The endpoint stops responding
              immediately and this can&rsquo;t be undone — you would need to deploy again.
            </AlertDialogDescription>
          </AlertDialogHeader>

          <AlertDialogFooter>
            <AlertDialogCancel asChild>
              <Button variant="outline" size="sm" data-testid="deploy-stop-cancel">
                Keep running
              </Button>
            </AlertDialogCancel>
            <Button
              variant="destructive"
              size="sm"
              disabled={busy}
              data-testid="deploy-stop-confirm"
              onClick={() => {
                setConfirming(false);
                actorRef.send({ type: 'STOP' });
              }}
            >
              Stop instances
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
