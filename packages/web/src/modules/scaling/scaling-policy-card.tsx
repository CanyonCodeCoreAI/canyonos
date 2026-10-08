import { zodResolver } from '@hookform/resolvers/zod';
import { MinusIcon, PencilIcon, PlusIcon, Trash2Icon, TriangleAlertIcon } from 'lucide-react';
import { useForm } from 'react-hook-form';
import type { ReactNode } from 'react';
import type { UseFormReturn } from 'react-hook-form';

import { MIN_REPLICAS_FLOOR, ScalingPolicySchema } from '@canyonos/api/scaling';
import type { ScalingMetric, ScalingPolicy, ScalingStatus } from '@canyonos/api/scaling';

import { Button } from '@repo/ui/shadcn/button';
import { cardVariants } from '@repo/ui/shadcn/card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@repo/ui/shadcn/collapsible';
import { ToggleGroup, ToggleGroupItem } from '@repo/ui/shadcn/toggle-group';
import { Tooltip, TooltipContent, TooltipTrigger } from '@repo/ui/shadcn/tooltip';
import {
  scalingErrorMessage,
  useDeleteScalingPolicy,
  useSaveScalingPolicy,
} from '@/modules/scaling/scaling.queries';

const GROW =
  'data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down overflow-hidden';
const WHEN_VIEWING = 'group-data-[state=open]/card:hidden';

type ScalingPolicyKind = 'throughput' | 'queue_length';
type Threshold = 'scale_up_above' | 'scale_down_below';

/** The two loads a policy can watch, in the words the screen uses for them. */
const POLICY_KINDS = {
  throughput: {
    label: 'Throughput',
    metric: 'requests_per_minute_per_replica',
    noun: 'throughput',
    unit: 'requests a minute per replica',
    defaults: { scale_up_above: 10, scale_down_below: 1 },
  },
  queue_length: {
    label: 'Queue length',
    metric: 'queue_length_total',
    noun: 'queue',
    unit: 'waiting requests',
    defaults: { scale_up_above: 3, scale_down_below: 1 },
  },
} as const satisfies Record<
  ScalingPolicyKind,
  {
    readonly label: string;
    readonly metric: ScalingMetric;
    readonly noun: string;
    readonly unit: string;
    readonly defaults: Record<Threshold, number>;
  }
>;

const KINDS = Object.keys(POLICY_KINDS) as ScalingPolicyKind[];

function kindOf(metric: ScalingMetric): ScalingPolicyKind {
  return metric === 'requests_per_minute_per_replica' ? 'throughput' : 'queue_length';
}

const NEW_POLICY: ScalingPolicy = {
  min_replicas: 1,
  max_replicas: 5,
  metric: POLICY_KINDS.throughput.metric,
  ...POLICY_KINDS.throughput.defaults,
};

/**
 * The workflow's one policy. The server says whether one is stored and whether the controller
 * accepts it; the card opens into an editor that mounts fresh each time, and the screen keys the
 * card on the stored policy so a save closes it.
 */
export function ScalingPolicyCard({
  project_id,
  policy,
}: {
  readonly project_id: string;
  readonly policy: ScalingStatus;
}) {
  const remove = useDeleteScalingPolicy(project_id);
  const destroy = () => remove.mutate();
  const error = remove.error
    ? scalingErrorMessage(remove.error, 'Could not delete the policy.')
    : null;

  return (
    <Collapsible asChild>
      <section
        className={cardVariants({ className: 'group/card' })}
        aria-label="Scaling policy"
        data-testid="scaling-policy"
        data-policy={policy.status}
      >
        <StoredPolicy
          policy={policy}
          deleting={remove.isPending}
          error={error}
          onDelete={destroy}
        />
        <CollapsibleContent className={GROW}>
          <PolicyEditor project_id={project_id} policy={policy} />
        </CollapsibleContent>
      </section>
    </Collapsible>
  );
}

function StoredPolicy({
  policy,
  deleting,
  error,
  onDelete,
}: {
  readonly policy: ScalingStatus;
  readonly deleting: boolean;
  readonly error: string | null;
  readonly onDelete: () => void;
}) {
  switch (policy.status) {
    case 'none':
      return <NoPolicy error={error} />;
    case 'applied':
      return (
        <AppliedPolicy
          policy={policy.policy}
          deleting={deleting}
          error={error}
          onDelete={onDelete}
        />
      );
    case 'invalid':
      return (
        <InvalidPolicy
          reason={policy.reason}
          deleting={deleting}
          error={error}
          onDelete={onDelete}
        />
      );
  }
}

function NoPolicy({ error }: { readonly error: string | null }) {
  return (
    <div
      className={`flex flex-col gap-4 p-5 ${WHEN_VIEWING}`}
      data-testid="scaling-policy-none"
      data-state="viewing"
    >
      <CardHeading title="No scaling policy">
        <CollapsibleTrigger asChild>
          <Button size="sm" className="text-xs" data-testid="policy-add">
            <PlusIcon aria-hidden />
            Add policy
          </Button>
        </CollapsibleTrigger>
      </CardHeading>
      <p className="text-muted-foreground text-sm">
        Every agent keeps its current replica count until the next reload, then the count set in
        global_controller.yaml. Add a policy to let each agent grow and shrink with its own load.
      </p>
      <CardError error={error} />
    </div>
  );
}

function AppliedPolicy({
  policy,
  deleting,
  error,
  onDelete,
}: {
  readonly policy: ScalingPolicy;
  readonly deleting: boolean;
  readonly error: string | null;
  readonly onDelete: () => void;
}) {
  const kind = kindOf(policy.metric);
  return (
    <div
      className={`flex flex-col gap-4 p-5 ${WHEN_VIEWING}`}
      data-testid="scaling-policy-applied"
      data-state={deleting ? 'deleting' : 'viewing'}
      data-kind={kind}
    >
      <CardHeading title={`${POLICY_KINDS[kind].label} policy`} live>
        <Tooltip>
          <TooltipTrigger asChild>
            <CollapsibleTrigger asChild>
              <Button
                size="icon"
                variant="ghost"
                className="text-muted-foreground hover:text-foreground size-8"
                aria-label="Edit policy"
                disabled={deleting}
                data-testid="policy-edit"
              >
                <PencilIcon aria-hidden />
              </Button>
            </CollapsibleTrigger>
          </TooltipTrigger>
          <TooltipContent sideOffset={4}>Edit policy</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="text-muted-foreground hover:text-foreground size-8 disabled:animate-pulse"
              aria-label={deleting ? 'Deleting…' : 'Delete policy'}
              disabled={deleting}
              onClick={onDelete}
              data-testid="policy-delete"
            >
              <Trash2Icon aria-hidden />
            </Button>
          </TooltipTrigger>
          <TooltipContent sideOffset={4}>Delete policy</TooltipContent>
        </Tooltip>
      </CardHeading>
      <PolicyRules
        kind={kind}
        values={policy}
        render={(value, name) => <Figure value={value} name={name} />}
      />
      <CardError error={error} />
    </div>
  );
}

function InvalidPolicy({
  reason,
  deleting,
  error,
  onDelete,
}: {
  readonly reason: string;
  readonly deleting: boolean;
  readonly error: string | null;
  readonly onDelete: () => void;
}) {
  return (
    <div
      className={`flex flex-col gap-4 p-5 ${WHEN_VIEWING}`}
      data-testid="scaling-policy-invalid"
      data-state={deleting ? 'deleting' : 'viewing'}
    >
      <CardHeading title="Invalid policy">
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="text-xs"
          disabled={deleting}
          onClick={onDelete}
          data-testid="policy-delete"
        >
          {deleting ? 'Deleting…' : 'Delete policy'}
        </Button>
        <CollapsibleTrigger asChild>
          <Button size="sm" className="text-xs" disabled={deleting} data-testid="policy-replace">
            Replace policy
          </Button>
        </CollapsibleTrigger>
      </CardHeading>
      <p className="text-foreground flex items-start gap-2 text-sm" data-testid="policy-invalid">
        <TriangleAlertIcon className="text-destructive mt-0.5 size-4 shrink-0" aria-hidden />
        <span>
          The stored policy breaks a rule, so the controller ignores it and every agent keeps its
          current replica count: <span className="font-mono text-xs">{reason}</span>. Replace it
          with a new policy, or delete it.
        </span>
      </p>
      <CardError error={error} />
    </div>
  );
}

type PolicyForm = UseFormReturn<ScalingPolicy>;

/** Mounts when the card opens, so every edit starts from what is stored right now. */
function PolicyEditor({
  project_id,
  policy,
}: {
  readonly project_id: string;
  readonly policy: ScalingStatus;
}) {
  const save = useSaveScalingPolicy(project_id);
  const is_new = policy.status !== 'applied';
  const form = useForm<ScalingPolicy>({
    resolver: zodResolver(ScalingPolicySchema),
    defaultValues: is_new ? NEW_POLICY : policy.policy,
    mode: 'onChange',
  });
  const values = form.watch();
  const kind = kindOf(values.metric);
  const submit = form.handleSubmit((body) => save.mutate(body));
  // Thresholds mean something else on the other load, so they restart from its defaults.
  const setKind = (next: ScalingPolicyKind) => {
    form.setValue('metric', POLICY_KINDS[next].metric, { shouldValidate: true });
    for (const field of ['scale_up_above', 'scale_down_below'] as const) {
      form.setValue(field, POLICY_KINDS[next].defaults[field], { shouldValidate: true });
    }
  };

  return (
    <form
      className="flex flex-col gap-4 p-5"
      aria-label={is_new ? 'New scaling policy' : 'Edit scaling policy'}
      data-testid="scaling-policy-editor"
      data-state={save.isPending ? 'saving' : 'editing'}
      data-kind={kind}
      onSubmit={submit}
    >
      <CardHeading title={is_new ? 'New policy' : 'Edit policy'}>
        <KindToggle kind={kind} disabled={save.isPending} onChange={setKind} />
      </CardHeading>
      <PolicyRules
        kind={kind}
        values={values}
        render={(value, name, bounds) => (
          <Stepper
            form={form}
            value={value}
            name={name}
            bounds={bounds}
            disabled={save.isPending}
          />
        )}
      />
      <CardError
        error={save.error ? scalingErrorMessage(save.error, 'Could not save the policy.') : null}
      />
      <div className="border-border/60 flex flex-wrap items-center justify-between gap-3 border-t pt-4">
        <p className="text-muted-foreground text-xs">
          Agents pick up the change on the controller&apos;s next poll.
        </p>
        <div className="flex items-center gap-2">
          <CollapsibleTrigger asChild>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="text-xs"
              disabled={save.isPending}
              data-testid="policy-cancel"
            >
              Cancel
            </Button>
          </CollapsibleTrigger>
          <Button
            type="submit"
            size="sm"
            className="text-xs"
            disabled={save.isPending || !form.formState.isValid}
            data-testid="policy-save"
          >
            {save.isPending ? 'Saving…' : 'Save policy'}
          </Button>
        </div>
      </div>
    </form>
  );
}

function CardHeading({
  title,
  live = false,
  children,
}: {
  readonly title: string;
  readonly live?: boolean;
  readonly children: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
      <h2 className="text-foreground flex items-center gap-2 text-sm font-semibold">
        <LiveDot live={live} />
        {title}
      </h2>
      <div className="flex items-center gap-1.5">{children}</div>
    </div>
  );
}

function LiveDot({ live }: { readonly live: boolean }) {
  if (!live) return null;
  return <span className="bg-primary size-1.5 rounded-full" aria-hidden />;
}

function CardError({ error }: { readonly error: string | null }) {
  if (error === null) return null;
  return (
    <p className="text-destructive text-xs" role="alert" data-testid="policy-error">
      {error}
    </p>
  );
}

/** Where a value may go, and the rule to quote when a typed value is pulled back inside. */
interface ValueBounds {
  readonly field: keyof Omit<ScalingPolicy, 'metric'>;
  readonly min: number;
  readonly min_reason: string;
  readonly max?: number;
  readonly max_reason?: string;
}

/** The policy as three plain rules; `render` draws each number, as a figure or a stepper. */
function PolicyRules({
  kind,
  values,
  render,
}: {
  readonly kind: ScalingPolicyKind;
  readonly values: Omit<ScalingPolicy, 'metric'>;
  readonly render: (value: number, name: string, bounds: ValueBounds) => ReactNode;
}) {
  const { noun, unit } = POLICY_KINDS[kind];
  return (
    <dl className="flex flex-col gap-2.5 text-sm" data-testid="policy-rules">
      <Rule label="Scale up">
        Add a replica when its {noun} stays above{' '}
        <Measure unit={unit}>
          {render(values.scale_up_above, 'scale-up threshold', {
            field: 'scale_up_above',
            min: values.scale_down_below + 1,
            min_reason: 'scale up must stay above scale down',
          })}
        </Measure>
      </Rule>
      <Rule label="Scale down">
        Remove one when it stays below{' '}
        <Measure unit={unit}>
          {render(values.scale_down_below, 'scale-down threshold', {
            field: 'scale_down_below',
            min: 0,
            min_reason: 'a threshold cannot be negative',
            max: values.scale_up_above - 1,
            max_reason: 'scale down must stay below scale up',
          })}
        </Measure>
      </Rule>
      <Rule label="Replicas">
        Keep each agent between{' '}
        {render(values.min_replicas, 'min replicas', {
          field: 'min_replicas',
          min: MIN_REPLICAS_FLOOR,
          min_reason: `each agent needs at least ${MIN_REPLICAS_FLOOR} replica`,
          max: values.max_replicas,
          max_reason: 'min replicas cannot pass max replicas',
        })}{' '}
        and{' '}
        {render(values.max_replicas, 'max replicas', {
          field: 'max_replicas',
          min: values.min_replicas,
          min_reason: 'max replicas cannot drop below min replicas',
        })}{' '}
        replicas
      </Rule>
    </dl>
  );
}

function Rule({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="grid grid-cols-1 items-baseline gap-x-4 gap-y-1 sm:grid-cols-[5.5rem_minmax(0,1fr)]">
      <dt className="text-muted-foreground text-[0.6875rem] font-semibold tracking-wide uppercase">
        {label}
      </dt>
      <dd className="text-foreground flex flex-wrap items-center gap-x-1.5 gap-y-1.5 leading-7">
        {children}
      </dd>
    </div>
  );
}

/** A number and its unit stay on one line together, so a wrap never strands the unit. */
function Measure({ unit, children }: { readonly unit: string; readonly children: ReactNode }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-x-1.5 gap-y-1.5">
      {children}
      <span className="whitespace-nowrap">{unit}</span>
    </span>
  );
}

function Figure({ value, name }: { readonly value: number; readonly name: string }) {
  return (
    <span
      className="bg-foreground/[0.05] text-foreground inline-flex h-7 min-w-9 items-center justify-center rounded-md px-2 font-mono text-sm font-semibold tabular-nums"
      data-testid={`policy-${name.replaceAll(' ', '-')}-value`}
    >
      {value}
    </span>
  );
}

function KindToggle({
  kind,
  disabled,
  onChange,
}: {
  readonly kind: ScalingPolicyKind;
  readonly disabled: boolean;
  readonly onChange: (kind: ScalingPolicyKind) => void;
}) {
  return (
    <ToggleGroup
      type="single"
      size="sm"
      value={kind}
      disabled={disabled}
      onValueChange={(next) => {
        if (next) onChange(next as ScalingPolicyKind);
      }}
      aria-label="Load to watch"
      data-testid="policy-kind"
    >
      {KINDS.map((option) => (
        <ToggleGroupItem key={option} value={option} data-testid={`policy-kind-${option}`}>
          {POLICY_KINDS[option].label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

const STEP_BUTTON_CLASS =
  'border-border/70 text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground ease-snappy flex size-7 items-center justify-center rounded-md border transition-[color,background-color,transform] duration-150 active:scale-[0.96] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-40 disabled:active:scale-100';

/**
 * One policy number. The buttons step inside the bounds; a typed value is pulled back inside
 * them on commit and the form error says which rule did it, until the field is typed in again.
 * The input is keyed on the value so a step rewrites what it shows.
 */
function Stepper({
  form,
  value,
  name,
  bounds,
  disabled,
}: {
  readonly form: PolicyForm;
  readonly value: number;
  readonly name: string;
  readonly bounds: ValueBounds;
  readonly disabled: boolean;
}) {
  const { field, min, max } = bounds;
  const test_id = `policy-${name.replaceAll(' ', '-')}`;
  const notice = form.formState.errors[field]?.message ?? null;
  const at_min = value <= min;
  const at_max = max !== undefined && value >= max;
  const set = (next: number) => form.setValue(field, next, { shouldValidate: true });
  const keep = (next: number, message: string) => {
    form.setValue(field, next);
    form.setError(field, { type: 'kept', message });
  };

  const commit = (input: HTMLInputElement) => {
    const raw = input.value.trim();
    input.value = String(value);
    if (raw === '') return;
    const next = Number(raw);
    if (!Number.isInteger(next)) return keep(value, 'Whole numbers only');
    if (next < min) return keep(min, `Kept at ${min}: ${bounds.min_reason}`);
    if (max !== undefined && next > max) return keep(max, `Kept at ${max}: ${bounds.max_reason}`);
    set(next);
  };

  return (
    <span className="inline-flex items-center gap-1" role="group" aria-label={name}>
      <button
        type="button"
        className={STEP_BUTTON_CLASS}
        aria-label={`Decrease ${name}`}
        disabled={disabled || at_min}
        onClick={() => set(value - 1)}
        data-testid={`${test_id}-decrease`}
      >
        <MinusIcon className="size-3.5" strokeWidth={2.2} aria-hidden />
      </button>
      <Tooltip open={notice !== null}>
        <TooltipTrigger asChild>
          <input
            key={value}
            type="text"
            inputMode="numeric"
            className="border-border/70 bg-background text-foreground focus-visible:border-foreground/40 aria-[invalid=true]:border-destructive/60 h-7 w-12 rounded-md border text-center font-mono text-sm font-semibold tabular-nums transition-[border-color] duration-150 focus-visible:outline-none disabled:opacity-50"
            aria-label={name}
            aria-invalid={notice !== null ? true : undefined}
            defaultValue={value}
            disabled={disabled}
            onChange={() => form.clearErrors(field)}
            onBlur={(event) => commit(event.currentTarget)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                commit(event.currentTarget);
              }
            }}
            data-testid={`${test_id}-value`}
          />
        </TooltipTrigger>
        <TooltipContent
          side="top"
          sideOffset={6}
          className="bg-destructive text-destructive-foreground"
          arrowClassName="bg-destructive fill-destructive"
          role="alert"
          data-testid={`${test_id}-notice`}
        >
          {notice}
        </TooltipContent>
      </Tooltip>
      <button
        type="button"
        className={STEP_BUTTON_CLASS}
        aria-label={`Increase ${name}`}
        disabled={disabled || at_max}
        onClick={() => set(value + 1)}
        data-testid={`${test_id}-increase`}
      >
        <PlusIcon className="size-3.5" strokeWidth={2.2} aria-hidden />
      </button>
    </span>
  );
}
