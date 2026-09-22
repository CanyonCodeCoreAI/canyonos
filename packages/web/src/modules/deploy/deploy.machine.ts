import { assign, fromCallback, fromPromise, setup } from 'xstate';
import type { ActorRefFrom, SnapshotFrom } from 'xstate';

import { DEPLOYMENT_STATUSES } from '@canyonos/api/deploy';
import type {
  DeployConfig,
  DeploymentInfo,
  DeploymentStatus,
  DeployStopCapability,
} from '@canyonos/api/deploy';

import { toast } from '@repo/ui/shadcn/sonner';
import { apiCall, ApiResponseError, forgeAuthApi } from '@/api';
import { stopDeployment } from '@/modules/deploy/deploy.queries';
import { DeployStreamNotFoundError, readDeployStream } from '@/modules/deploy/deploy.stream';

// Delay before re-opening the stream after a transport drop. The reader resumes from the last seq via
// `last-event-id`, so no progress is lost across the gap.
const RECONNECT_DELAY_MS = 1500;

const statusRank = (status: DeploymentStatus): number => DEPLOYMENT_STATUSES.indexOf(status);

function stopRequestErrorMessage(error: unknown): string {
  if (error instanceof ApiResponseError && error.code === 'deploy.missing_teardown_handles') {
    return 'This deployment predates Stop support. Deploy again before stopping it.';
  }
  if (error instanceof ApiResponseError && error.status === 409) {
    return 'This deployment is no longer running.';
  }
  return 'Could not stop this deployment. Please try again.';
}

export interface DeployStatusInput {
  readonly project_id: string;
  readonly deploy_id: string;
}

export interface DeployStatusContext {
  readonly project_id: string;
  readonly deploy_id: string;
  // Loaded once up front so every view reads the project/setup/provider from the machine rather than
  // fetching for itself.
  readonly config: DeployConfig | null;
  // The furthest lifecycle status seen — seeded from the loaded deployment, then only advanced by the
  // stream so a fresh replay never rewinds the view.
  readonly status: DeploymentStatus;
  readonly address: string | null;
  readonly errorMessage: string | null;
  readonly reconnecting: boolean;
  readonly stopCapability: DeployStopCapability | null;
  // The teardown ran and failed. Persisted on the row, so it survives a reload as a standing warning.
  readonly stopFailure: string | null;
}

export type DeployStatusEvent =
  | { type: 'STREAM.PHASE'; status: DeploymentStatus }
  | { type: 'STREAM.SUCCEEDED'; address: string | null }
  | { type: 'STREAM.FAILED'; message: string | null }
  | { type: 'STREAM.STOPPED'; message: string | null }
  | { type: 'STREAM.STOP_FAILED'; message: string | null }
  | { type: 'STREAM.DROPPED' }
  | { type: 'STREAM.NOT_FOUND' }
  | { type: 'RETRY' }
  | { type: 'STOP' };

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true }
    );
  });
}

export const deployStatusMachine = setup({
  types: {
    input: {} as DeployStatusInput,
    context: {} as DeployStatusContext,
    events: {} as DeployStatusEvent,
  },
  actors: {
    // Loads everything needed to pick the screen: the deploy config AND the deployment record, so the
    // machine knows the status up front and never opens a stream for a deploy that is already done.
    loadDeploy: fromPromise<{ config: DeployConfig; deploy: DeploymentInfo }, DeployStatusInput>(
      async ({ input }) => {
        const [config, deploy] = await Promise.all([
          apiCall<DeployConfig>(() => forgeAuthApi.projects[input.project_id]!.deploy.config.get()),
          apiCall<DeploymentInfo>(() =>
            forgeAuthApi.projects[input.project_id]!.deploy[input.deploy_id]!.get()
          ),
        ]);
        return { config, deploy };
      }
    ),
    requestStop: fromPromise<void, DeployStatusInput>(async ({ input }) => {
      await stopDeployment(input.project_id, input.deploy_id);
    }),
    // Follows the SSE stream to its terminal event, translating each frame into a machine event and
    // owning the reconnect loop: a transport drop flips `reconnecting` and retries from the last seq,
    // while a 404 is terminal and surfaces `NOT_FOUND`. `following` names which lifecycle ends the
    // loop — a teardown replay re-delivers the deploy's own `succeeded` frame, which must not stop
    // the reconnects.
    streamDeployment: fromCallback<
      DeployStatusEvent,
      DeployStatusInput & { following: 'deploy' | 'teardown' }
    >(({ sendBack, input }) => {
      const controller = new AbortController();
      let cancelled = false;
      let lastSeq = 0;
      let terminal = false;

      async function run() {
        while (!cancelled && !terminal) {
          try {
            await readDeployStream(
              input.project_id,
              input.deploy_id,
              lastSeq > 0 ? String(lastSeq) : undefined,
              (event) => {
                lastSeq = Math.max(lastSeq, event.seq);
                if (event.type === 'phase') {
                  sendBack({ type: 'STREAM.PHASE', status: event.phase });
                } else if (event.type === 'succeeded') {
                  if (input.following === 'deploy') terminal = true;
                  sendBack({ type: 'STREAM.SUCCEEDED', address: event.address });
                } else if (event.type === 'stopped') {
                  terminal = true;
                  sendBack({ type: 'STREAM.STOPPED', message: event.message });
                } else if (event.type === 'stop_failed') {
                  terminal = true;
                  sendBack({ type: 'STREAM.STOP_FAILED', message: event.message });
                } else {
                  terminal = true;
                  sendBack({ type: 'STREAM.FAILED', message: event.message });
                }
              },
              controller.signal
            );
          } catch (error) {
            if (cancelled || controller.signal.aborted) return;
            if (error instanceof DeployStreamNotFoundError) {
              sendBack({ type: 'STREAM.NOT_FOUND' });
              return;
            }
            sendBack({ type: 'STREAM.DROPPED' });
          }
          if (cancelled || terminal) return;
          await sleep(RECONNECT_DELAY_MS, controller.signal);
        }
      }

      void run();

      return () => {
        cancelled = true;
        controller.abort();
      };
    }),
  },
}).createMachine({
  id: 'deployStatus',
  initial: 'loading',
  context: ({ input }) => ({
    project_id: input.project_id,
    deploy_id: input.deploy_id,
    config: null,
    status: 'pending',
    address: null,
    errorMessage: null,
    reconnecting: false,
    stopCapability: null,
    stopFailure: null,
  }),
  states: {
    loading: {
      invoke: {
        src: 'loadDeploy',
        input: ({ context }) => ({ project_id: context.project_id, deploy_id: context.deploy_id }),
        // Branch on the loaded status: a terminal deploy renders its outcome directly; an in-flight
        // one seeds the current status and opens the stream to follow it live.
        onDone: [
          {
            guard: ({ event }) => event.output.deploy.status === 'success',
            target: 'succeeded',
            actions: assign({
              config: ({ event }) => event.output.config,
              status: 'success',
              address: ({ event }) => event.output.deploy.address,
              stopCapability: ({ event }) => event.output.deploy.stop,
              stopFailure: ({ event }) => event.output.deploy.stop_error,
            }),
          },
          {
            guard: ({ event }) => event.output.deploy.status === 'stopped',
            target: 'stopped',
            actions: assign({
              config: ({ event }) => event.output.config,
              status: 'stopped',
              stopCapability: ({ event }) => event.output.deploy.stop,
              stopFailure: ({ event }) => event.output.deploy.stop_error,
            }),
          },
          {
            guard: ({ event }) => event.output.deploy.status === 'stopping',
            target: 'stopping',
            actions: assign({
              config: ({ event }) => event.output.config,
              status: 'stopping',
              stopCapability: ({ event }) => event.output.deploy.stop,
              address: ({ event }) => event.output.deploy.address,
            }),
          },
          {
            guard: ({ event }) => event.output.deploy.status === 'failed',
            target: 'failed',
            actions: assign({
              config: ({ event }) => event.output.config,
              status: ({ event }) => event.output.deploy.status,
              stopCapability: ({ event }) => event.output.deploy.stop,
              errorMessage: ({ event }) => event.output.deploy.error,
            }),
          },
          {
            target: 'running',
            actions: assign({
              config: ({ event }) => event.output.config,
              status: ({ event }) => event.output.deploy.status,
              stopCapability: ({ event }) => event.output.deploy.stop,
              address: ({ event }) => event.output.deploy.address,
            }),
          },
        ],
        onError: [
          {
            guard: ({ event }) =>
              event.error instanceof ApiResponseError && event.error.status === 404,
            target: 'notFound',
          },
          { target: 'error' },
        ],
      },
    },
    error: {
      on: { RETRY: 'loading' },
    },
    running: {
      invoke: {
        src: 'streamDeployment',
        input: ({ context }) => ({
          project_id: context.project_id,
          deploy_id: context.deploy_id,
          following: 'deploy' as const,
        }),
      },
      on: {
        'STREAM.PHASE': {
          actions: assign({
            // Only advance — the stream replays from seq 0, so ignore any phase behind where we started.
            status: ({ context, event }) =>
              statusRank(event.status) > statusRank(context.status) ? event.status : context.status,
            reconnecting: false,
          }),
        },
        'STREAM.DROPPED': { actions: assign({ reconnecting: true }) },
        'STREAM.SUCCEEDED': {
          target: 'succeeded',
          actions: assign({
            status: 'success',
            address: ({ event }) => event.address,
            reconnecting: false,
          }),
        },
        'STREAM.FAILED': {
          target: 'failed',
          actions: assign({
            errorMessage: ({ event }) => event.message,
            reconnecting: false,
          }),
        },
        'STREAM.NOT_FOUND': 'notFound',
      },
    },
    succeeded: {
      on: {
        STOP: {
          target: 'requestingStop',
          actions: assign({ stopFailure: null }),
        },
      },
    },
    // Success only enqueues the teardown — the stream reports the outcome.
    requestingStop: {
      invoke: {
        src: 'requestStop',
        input: ({ context }) => ({ project_id: context.project_id, deploy_id: context.deploy_id }),
        onDone: { target: 'stopping', actions: assign({ status: 'stopping' }) },
        onError: {
          target: 'succeeded',
          actions: ({ event }) => {
            toast.error(stopRequestErrorMessage(event.error), { testId: 'app-toast' });
          },
        },
      },
    },
    // Follows the teardown to its own terminal event, ignoring the replayed `succeeded` frame.
    stopping: {
      invoke: {
        src: 'streamDeployment',
        input: ({ context }) => ({
          project_id: context.project_id,
          deploy_id: context.deploy_id,
          following: 'teardown' as const,
        }),
      },
      on: {
        'STREAM.PHASE': {
          actions: assign({
            status: ({ context, event }) =>
              statusRank(event.status) > statusRank(context.status) ? event.status : context.status,
            reconnecting: false,
          }),
        },
        'STREAM.DROPPED': { actions: assign({ reconnecting: true }) },
        'STREAM.STOPPED': {
          target: 'stopped',
          actions: assign({
            status: 'stopped',
            stopFailure: ({ event }) => event.message,
          }),
        },
        // Back to the live summary — the deployment never stopped being deployed.
        'STREAM.STOP_FAILED': {
          target: 'succeeded',
          actions: assign({
            status: 'success',
            reconnecting: false,
            stopFailure: ({ event }) =>
              event.message ?? 'The instances could not be stopped and may still be running.',
          }),
        },
        'STREAM.FAILED': {
          target: 'failed',
          actions: assign({ errorMessage: ({ event }) => event.message, reconnecting: false }),
        },
        'STREAM.NOT_FOUND': 'notFound',
      },
    },
    stopped: {},
    // Terminal. A deployment is one-shot — starting over means a brand-new deploy, which is the deploy
    // screen's job, so the failed view links there rather than the machine re-triggering in place.
    failed: {},
    notFound: {},
  },
});

export type DeployStatusMachineActorRef = ActorRefFrom<typeof deployStatusMachine>;

type DeployStatusSnapshot = SnapshotFrom<typeof deployStatusMachine>;

// The one screen the flow is on, derived from machine state. `running` and `failed` share the
// progress view; `succeeded` is the summary.
export type DeployScreen = 'loading' | 'error' | 'progress' | 'complete' | 'stopped' | 'notFound';

export function selectDeployScreen(state: DeployStatusSnapshot): DeployScreen {
  if (state.matches('loading')) return 'loading';
  if (state.matches('error')) return 'error';
  if (state.matches('succeeded') || state.matches('requestingStop') || state.matches('stopping'))
    return 'complete';
  if (state.matches('stopped')) return 'stopped';
  if (state.matches('notFound')) return 'notFound';
  return 'progress';
}

export const selectStopState = (state: DeployStatusSnapshot) => ({
  requesting: state.matches('requestingStop'),
  stopping: state.matches('stopping'),
  capability: state.context.stopCapability,
});

export const selectStopFailure = (state: DeployStatusSnapshot): string | null =>
  state.context.stopFailure;
