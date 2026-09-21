import { shallowEqual, useSelector } from '@xstate/react';
import { CheckIcon } from 'lucide-react';

import type { DeployConfig } from '@cc-forge/api/deploy';

import { SectionLabel } from '@repo/ui/components/section-label';
import { Card } from '@repo/ui/shadcn/card';
import { AgentAddress } from '@/modules/deploy/components/agent-address';
import { DeployStopButton } from '@/modules/deploy/components/deploy-stop-button';
import { DeployStopFailedNotice } from '@/modules/deploy/components/deploy-stop-failed-notice';
import { DeployTestPanel } from '@/modules/deploy/components/deploy-test-panel';
import { PROVISIONED_RESOURCES } from '@/modules/deploy/deploy.mock';
import type { DeployStatusMachineActorRef } from '@/modules/deploy/deploy.machine';
import type { DeployResourceSummary } from '@/modules/deploy/deploy.mock';

export function DeployCompleteScreen({ actorRef }: { actorRef: DeployStatusMachineActorRef }) {
  const { deploy_id, address, config } = useSelector(
    actorRef,
    (state) => ({
      deploy_id: state.context.deploy_id,
      address: state.context.address,
      config: state.context.config,
    }),
    shallowEqual
  );

  // The machine only routes here after `loadDeploy` resolved, so the config is always present.
  if (!config) return null;

  return (
    <main
      className="flex min-h-0 flex-1 flex-col px-7 pt-6 pb-16"
      data-testid="deploy-complete-screen"
    >
      <div className="mx-auto flex w-full max-w-[47.5rem] flex-col gap-6">
        <CompleteHero actorRef={actorRef} config={config} />

        <DeployStopFailedNotice actorRef={actorRef} />

        {address ? (
          <>
            <section className="flex flex-col gap-2.5" data-testid="deploy-endpoint">
              <SectionLabel as="h2">Endpoint</SectionLabel>
              <Card className="px-4 py-3.5">
                <AgentAddress
                  address={address}
                  copy_label="Copy Endpoint"
                  copy_test_id="deploy-endpoint-copy"
                />
              </Card>
            </section>
            <DeployTestPanel config={config} deploy_id={deploy_id} />
          </>
        ) : null}

        <section className="flex flex-col gap-2.75" data-testid="deploy-resource-summary">
          <SectionLabel as="h2">Provisioned resources</SectionLabel>
          <Card className="overflow-hidden py-0">
            <ul className="divide-border/60 divide-y">
              {PROVISIONED_RESOURCES.map((resource) => (
                <ResourceRow key={resource.id} resource={resource} />
              ))}
            </ul>
          </Card>
        </section>
      </div>
    </main>
  );
}

function CompleteHero({
  actorRef,
  config,
}: {
  actorRef: DeployStatusMachineActorRef;
  config: DeployConfig;
}) {
  return (
    <Card
      className="border-primary/30 bg-primary/[0.06] rounded-lg border p-5.5"
      data-testid="deploy-complete-hero"
    >
      <div className="flex min-w-0 items-start gap-4">
        <span className="bg-primary text-primary-foreground flex size-11.5 shrink-0 items-center justify-center rounded-full shadow-[0_4px_14px_-2px_color-mix(in_oklab,var(--primary)_45%,transparent)]">
          <CheckIcon className="size-6" strokeWidth={2.8} aria-hidden />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-foreground min-w-0 flex-1 text-[1.375rem] leading-tight font-bold tracking-tight text-balance">
              {config.project_name} is live
            </h1>
            <DeployStopButton actorRef={actorRef} />
          </div>
          <p className="text-secondary-foreground text-sm leading-relaxed text-pretty">
            Deployed from setup <b className="font-semibold">{config.name}</b> to{' '}
            {config.provider_name}.
          </p>
        </div>
      </div>
    </Card>
  );
}

function ResourceRow({ resource }: { resource: DeployResourceSummary }) {
  const Icon = resource.icon;

  return (
    <li
      className="flex items-center gap-3 px-5 py-3.75"
      data-testid={`deploy-resource-${resource.id}`}
    >
      <Icon
        className="size-3.75 shrink-0"
        style={{ color: resource.accent }}
        strokeWidth={2}
        aria-hidden
      />
      <div className="flex w-[7.375rem] shrink-0 flex-col gap-0.5">
        <span className="text-foreground text-[0.8125rem] font-bold">{resource.title}</span>
        <span className="text-muted-foreground text-xs">{resource.subtitle}</span>
      </div>
      <span className="text-secondary-foreground min-w-0 flex-1 truncate font-mono text-xs">
        {resource.detail}
      </span>
      <span className="text-primary flex shrink-0 items-center gap-1.5 text-xs font-semibold">
        <CheckIcon className="size-3.5" strokeWidth={2.6} aria-hidden />
        Ready
      </span>
    </li>
  );
}
