import { zodResolver } from '@hookform/resolvers/zod';
import { useQuery } from '@tanstack/react-query';
import { CloudUploadIcon } from 'lucide-react';
import { useForm } from 'react-hook-form';

import type { DeployConfig } from '@canyonos/api/deploy';

import { Button } from '@repo/ui/shadcn/button';
import { apiCall, forgeAuthApi } from '@/api';
import { QueryError } from '@/modules/core/components/QueryError';
import { DeploySkeleton } from '@/modules/deploy/components/deploy-skeleton';
import { StartingConfigCard } from '@/modules/deploy/components/starting-config-card';
import { deployErrorFor } from '@/modules/deploy/deploy.errors';
import { useTriggerDeploy } from '@/modules/deploy/deploy.mutations';
import {
  STARTING_CONFIG_DEFAULTS,
  StartingConfigSchema,
} from '@/modules/deploy/deploy.starting-config';
import { projectQueryKeys } from '@/modules/projects/projects.query-cache';
import type { StartingConfigInput } from '@/modules/deploy/deploy.starting-config';

/**
 * How big the fleet starts and how far it may grow.
 *
 * Split out of the scaling policy flow, where it used to appear after the analysis: the policy is
 * what you want of the deployment, and this is what the deployment is allowed to be. They are edited
 * on different days by different people, and a reader who came to raise a ceiling should not have to
 * re-answer four questions about traffic to reach it.
 */
export function DeploymentConfigScreen({ project_id }: { readonly project_id: string }) {
  const config_query = useQuery({
    queryKey: projectQueryKeys.deployConfig(project_id),
    queryFn: () =>
      apiCall<DeployConfig>(() => forgeAuthApi.projects[project_id]!.deploy.config.get()),
    retry: false,
  });

  const form = useForm<StartingConfigInput>({
    resolver: zodResolver(StartingConfigSchema),
    defaultValues: STARTING_CONFIG_DEFAULTS,
  });
  const deployMutation = useTriggerDeploy(project_id);

  if (config_query.isPending) return <DeploySkeleton />;

  if (config_query.error || !config_query.data) {
    return (
      <QueryError
        message="Could not load this deployment configuration."
        onRetry={() => void config_query.refetch()}
        className="m-7"
        test_id="deployment-config-error"
      />
    );
  }

  return (
    <main className="flex min-h-0 flex-1 flex-col" data-testid="deployment-config-screen">
      <div className="mx-auto flex h-fit w-full max-w-[640px] flex-col gap-6 px-7 pt-6 pb-6">
        <header className="flex flex-col gap-2" data-testid="deployment-config-hero">
          <h1 className="text-foreground text-[1.75rem] leading-tight font-bold tracking-tight">
            Deployment config for {config_query.data.project_name}
          </h1>
          <p className="text-muted-foreground text-sm">
            The fleet {config_query.data.project_name} starts on, and the ceiling it may grow to.
          </p>
        </header>

        <StartingConfigCard form={form} is_submitting={deployMutation.isPending} />

        {/* The end of the upload flow: policy, then emulation, then the fleet — and this is where it
            gets deployed. A project that has run before deploys through the review instead, so it is
            not offered a second way in from here. */}
        {config_query.data.has_previous_deploy ? null : (
          <footer className="flex flex-col gap-2">
            <Button
              type="button"
              className="self-start"
              disabled={deployMutation.isPending}
              onClick={() => void form.handleSubmit(() => deployMutation.mutate())()}
              data-testid="deployment-config-deploy"
            >
              <CloudUploadIcon aria-hidden />
              Deploy {config_query.data.project_name}
            </Button>
            {deployMutation.isError ? (
              <p
                className="text-destructive text-sm"
                role="alert"
                data-testid="deployment-config-error"
              >
                {deployErrorFor(deployMutation.error)}
              </p>
            ) : null}
          </footer>
        )}
      </div>
    </main>
  );
}
