import { useSelector } from '@xstate/react';

import { Notice, NoticeCode } from '@repo/ui/components/notice';
import { selectStopFailure } from '@/modules/deploy/deploy.machine';
import type { DeployStatusMachineActorRef } from '@/modules/deploy/deploy.machine';

/** Reads the persisted `stop_error`, so the warning survives a reload. */
export function DeployStopFailedNotice({ actorRef }: { actorRef: DeployStatusMachineActorRef }) {
  const failure = useSelector(actorRef, selectStopFailure);
  if (!failure) return null;

  return (
    <Notice
      title="Stopping did not finish — instances may still be running"
      data-testid="deploy-stop-failed-notice"
    >
      <p>
        This deployment is still live. The last attempt to terminate its instances failed, so they
        may still be up and billing. Try stopping again, or check them in the AWS console.
      </p>
      <NoticeCode className="break-all" data-testid="deploy-stop-failed-reason">
        {failure}
      </NoticeCode>
    </Notice>
  );
}
