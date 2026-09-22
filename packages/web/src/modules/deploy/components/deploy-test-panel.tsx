import { useMutation } from '@tanstack/react-query';
import { AlertTriangleIcon, Loader2Icon, PlayIcon } from 'lucide-react';
import { useState } from 'react';

import type { DeployConfig, DeployTestResult } from '@canyonos/api/deploy';

import { CopyButton } from '@repo/ui/components/copy-button';
import { Alert, AlertDescription, AlertTitle } from '@repo/ui/shadcn/alert';
import { Button } from '@repo/ui/shadcn/button';
import { Card } from '@repo/ui/shadcn/card';
import { Input } from '@repo/ui/shadcn/input';
import { cn } from '@repo/ui/utils';
import { apiCall, forgeAuthApi } from '@/api';

interface DeployTestPanelProps {
  config: DeployConfig;
  deploy_id: string;
}

const QUERY_PLACEHOLDER = 'Analyze 40% Apple, 35% Microsoft and 25% Nvidia over the last 6 months';

export function DeployTestPanel({ config, deploy_id }: DeployTestPanelProps) {
  const [query, setQuery] = useState('');
  // The query the visible response belongs to, so the button can go quiet once it has answered and
  // wake up again when the reader asks something new.
  const [tested_query, setTestedQuery] = useState<string | null>(null);

  const testMutation = useMutation({
    mutationFn: (value: string) =>
      apiCall<DeployTestResult>(() =>
        forgeAuthApi.projects[config.project_id]!.deploy[deploy_id]!.test.post({ query: value })
      ),
  });

  const testErrorMessage = testMutation.isError
    ? testMutation.error instanceof Error
      ? testMutation.error.message
      : 'Could not reach the deployed endpoint.'
    : undefined;

  const trimmedQuery = query.trim();
  const answered = testMutation.isSuccess && tested_query === trimmedQuery;
  const canRun = !testMutation.isPending && trimmedQuery.length > 0 && !answered;

  const runTest = () => {
    setTestedQuery(trimmedQuery);
    testMutation.mutate(trimmedQuery);
  };

  return (
    <section className="flex flex-col gap-2.5" data-testid="deploy-test-panel">
      <Card className="flex flex-col gap-3 p-4">
        <div className="flex min-w-0 flex-col gap-1">
          <h2 className="text-foreground text-sm font-semibold">
            Run a test to {config.project_name}
          </h2>
          <p className="text-muted-foreground text-[0.8125rem]">
            Send a query to the deployed agent and inspect the raw response.
          </p>
        </div>

        {/* A single line: queries here are one sentence, and the response lands in its own card
            below, so the input has nothing to grow for. Enter runs the test. */}
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' || !canRun) return;
            event.preventDefault();
            runTest();
          }}
          placeholder={QUERY_PLACEHOLDER}
          aria-label="Query"
          className="h-9 text-[0.8125rem]"
          data-testid="deploy-test-query-input"
        />

        <div className="flex">
          <Button
            type="button"
            size="sm"
            onClick={runTest}
            disabled={!canRun}
            data-testid="deploy-test-run"
          >
            {testMutation.isPending ? (
              <Loader2Icon className="animate-spin" aria-hidden />
            ) : (
              <PlayIcon aria-hidden />
            )}
            {testMutation.isPending ? 'Testing…' : 'Test'}
          </Button>
        </div>
      </Card>

      <TestResponse result={testMutation.data ?? undefined} errorMessage={testErrorMessage} />
    </section>
  );
}

function TestResponse({
  result,
  errorMessage,
}: {
  result?: DeployTestResult;
  errorMessage?: string;
}) {
  if (errorMessage) {
    return (
      <Alert
        variant="destructive"
        data-testid="deploy-test-response"
        data-state="error"
        className="animate-in fade-in-0 slide-in-from-top-1"
      >
        <AlertTriangleIcon strokeWidth={2.2} aria-hidden />
        <AlertTitle>Test request failed</AlertTitle>
        <AlertDescription>{errorMessage}</AlertDescription>
      </Alert>
    );
  }

  if (!result) return null;

  const bodyText = formatBody(result.body);

  return (
    <Card
      data-testid="deploy-test-response"
      data-state={result.ok ? 'ok' : 'error'}
      className="animate-in fade-in-0 slide-in-from-top-1 flex flex-col gap-3 overflow-hidden p-4"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-xs font-semibold">
          <span
            className={cn(
              'size-2 shrink-0 rounded-full',
              result.ok ? 'bg-primary' : 'bg-destructive'
            )}
            aria-hidden
          />
          <span className="text-muted-foreground">Response</span>
          <span className={cn('font-mono', result.ok ? 'text-foreground' : 'text-destructive')}>
            HTTP {result.status}
          </span>
        </div>
        {bodyText ? <CopyButton value={bodyText} data-testid="deploy-test-response-copy" /> : null}
      </div>
      <pre className="text-foreground overflow-x-auto font-mono text-sm leading-relaxed">
        {bodyText}
      </pre>
    </Card>
  );
}

function formatBody(body: unknown): string {
  if (body === null || body === undefined) return '';
  if (typeof body === 'string') return body;
  return JSON.stringify(body, null, 2);
}
