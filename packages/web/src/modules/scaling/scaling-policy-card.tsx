import { MinusIcon, PlusIcon, TriangleAlertIcon } from 'lucide-react';
import { useState } from 'react';
import type { Dispatch, ReactNode } from 'react';

import { MIN_REPLICAS_FLOOR } from '@canyonos/api/scaling';
import type { ScalingPolicy, ScalingResponse } from '@canyonos/api/scaling';

import { Button } from '@repo/ui/shadcn/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@repo/ui/shadcn/select';
import { freeAgents } from '@/modules/scaling/scaling-drafts';
import { useDeleteScalingPolicy, useSaveScalingPolicy } from '@/modules/scaling/scaling.queries';
import type {
  ScalingDraft,
  ScalingDraftsAction,
  ScalingPolicyKind,
} from '@/modules/scaling/scaling-drafts';

type PolicyValues = Omit<ScalingPolicy, 'metric'>;

export const POLICY_KINDS = {
  throughput: {
    label: 'Throughput',
    comparison: 'when throughput is',
    metric: 'requests_per_minute_per_replica',
    unit: 'requests / min per replica',
    defaults: { scale_up_above: 10, scale_down_below: 1, min_replicas: 1, max_replicas: 5 },
  },
  queue_length: {
    label: 'Queue length',
    comparison: 'when queue length is',
    metric: 'queue_length_total',
    unit: 'queued requests',
    defaults: { scale_up_above: 3, scale_down_below: 1, min_replicas: 1, max_replicas: 5 },
  },
} as const satisfies Record<
  ScalingPolicyKind,
  {
    readonly label: string;
    readonly comparison: string;
    readonly metric: ScalingPolicy['metric'];
    readonly unit: string;
    readonly defaults: PolicyValues;
  }
>;

function kindOf(policy: ScalingPolicy): ScalingPolicyKind {
  return policy.metric === 'requests_per_minute_per_replica' ? 'throughput' : 'queue_length';
}

export function DraftPolicyCard({
  project_id,
  draft,
  response,
  drafts,
  dispatch,
}: {
  readonly project_id: string;
  readonly draft: ScalingDraft;
  readonly response: ScalingResponse;
  readonly drafts: readonly ScalingDraft[];
  readonly dispatch: Dispatch<ScalingDraftsAction>;
}) {
  const definition = POLICY_KINDS[draft.kind];
  const [values, setValues] = useState<PolicyValues>(definition.defaults);
  const save = useSaveScalingPolicy(project_id);
  const agent_options = freeAgents(response, drafts, draft.id);
  const agent_name =
    draft.agent_name !== null && agent_options.includes(draft.agent_name)
      ? draft.agent_name
      : undefined;

  const submit = () => {
    if (!agent_name) return;
    save.mutate(
      { agent_name, policy: { ...values, metric: definition.metric } },
      { onSuccess: () => dispatch({ type: 'saved', id: draft.id }) }
    );
  };

  return (
    <PolicyCardFrame
      state="draft"
      kind={draft.kind}
      agent_name={agent_name}
      aria_label={`New ${definition.label.toLowerCase()} policy`}
    >
      <PolicyCardHeader title={definition.label}>
        <Select
          value={agent_name ?? ''}
          onValueChange={(picked) =>
            dispatch({ type: 'pick_agent', id: draft.id, agent_name: picked })
          }
          disabled={save.isPending}
        >
          <SelectTrigger
            className="h-8 w-44 text-xs"
            aria-label="Agent this policy applies to"
            data-testid="policy-agent"
          >
            <SelectValue placeholder="Select an agent" />
          </SelectTrigger>
          <SelectContent align="end">
            {agent_options.map((option) => (
              <SelectItem key={option} value={option}>
                {option}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </PolicyCardHeader>
      <PolicyValuesEditor
        kind={draft.kind}
        values={values}
        onChange={setValues}
        disabled={save.isPending}
      >
        <Button
          size="sm"
          variant="ghost"
          disabled={save.isPending}
          data-testid="policy-discard"
          onClick={() => dispatch({ type: 'discard', id: draft.id })}
        >
          Discard
        </Button>
        <Button
          size="sm"
          disabled={!agent_name || save.isPending}
          data-testid="policy-save"
          onClick={submit}
        >
          {save.isPending ? 'Saving…' : 'Save'}
        </Button>
      </PolicyValuesEditor>
      <PolicyCardError error={save.error} />
    </PolicyCardFrame>
  );
}

export function SavedPolicyCard({
  project_id,
  agent_name,
  policy,
}: {
  readonly project_id: string;
  readonly agent_name: string;
  readonly policy: ScalingPolicy;
}) {
  const kind = kindOf(policy);
  const definition = POLICY_KINDS[kind];
  const [values, setValues] = useState<PolicyValues>(policy);
  const save = useSaveScalingPolicy(project_id);
  const remove = useDeleteScalingPolicy(project_id);
  const is_busy = save.isPending || remove.isPending;

  const submit = () => {
    remove.reset();
    save.mutate({ agent_name, policy: { ...values, metric: definition.metric } });
  };
  const deletePolicy = () => {
    save.reset();
    remove.mutate(agent_name);
  };

  return (
    <PolicyCardFrame
      state="saved"
      kind={kind}
      agent_name={agent_name}
      aria_label={`${definition.label} policy for ${agent_name}`}
    >
      <PolicyCardHeader title={definition.label}>
        <span
          className="border-border/70 text-foreground flex h-8 w-44 items-center rounded-md border px-3 font-mono text-xs"
          data-testid="policy-agent"
        >
          {agent_name}
        </span>
      </PolicyCardHeader>
      <PolicyValuesEditor kind={kind} values={values} onChange={setValues} disabled={is_busy}>
        <Button
          size="sm"
          variant="ghost"
          disabled={is_busy}
          data-testid="policy-delete"
          onClick={deletePolicy}
        >
          {remove.isPending ? 'Deleting…' : 'Delete'}
        </Button>
        <Button size="sm" disabled={is_busy} data-testid="policy-save" onClick={submit}>
          {save.isPending ? 'Saving…' : 'Save'}
        </Button>
      </PolicyValuesEditor>
      <PolicyCardError error={save.error ?? remove.error} />
    </PolicyCardFrame>
  );
}

export function InvalidPolicyCard({
  project_id,
  agent_name,
}: {
  readonly project_id: string;
  readonly agent_name: string;
}) {
  const remove = useDeleteScalingPolicy(project_id);

  return (
    <PolicyCardFrame
      state="invalid"
      agent_name={agent_name}
      aria_label={`Invalid policy for ${agent_name}`}
    >
      <PolicyCardHeader title="Invalid policy">
        <span className="text-foreground font-mono text-xs" data-testid="policy-agent">
          {agent_name}
        </span>
      </PolicyCardHeader>
      <p
        className="text-muted-foreground flex items-start gap-2 text-xs"
        data-testid="policy-invalid"
      >
        <TriangleAlertIcon className="text-destructive mt-px size-3.5 shrink-0" aria-hidden />
        The stored policy for this agent is invalid, so the controller ignores it. Delete it to
        configure a new policy.
      </p>
      <div className="border-border/70 flex justify-end border-t pt-3">
        <Button
          size="sm"
          variant="outline"
          disabled={remove.isPending}
          data-testid="policy-delete"
          onClick={() => remove.mutate(agent_name)}
        >
          {remove.isPending ? 'Deleting…' : 'Delete'}
        </Button>
      </div>
      <PolicyCardError error={remove.error} />
    </PolicyCardFrame>
  );
}

function PolicyCardFrame({
  state,
  kind,
  agent_name,
  aria_label,
  children,
}: {
  readonly state: 'draft' | 'saved' | 'invalid';
  readonly kind?: ScalingPolicyKind;
  readonly agent_name?: string;
  readonly aria_label: string;
  readonly children: ReactNode;
}) {
  return (
    <section
      className="border-border/70 bg-card flex flex-col gap-3 rounded-[1.125rem] border p-4 shadow-xs"
      aria-label={aria_label}
      data-testid={`scaling-policy-${state}`}
      data-kind={kind}
      data-agent={agent_name}
    >
      {children}
    </section>
  );
}

function PolicyCardHeader({
  title,
  children,
}: {
  readonly title: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
      <h2 className="text-foreground text-sm font-semibold">{title}</h2>
      {children}
    </div>
  );
}

function PolicyCardError({ error }: { readonly error: Error | null }) {
  if (!error) return null;
  return (
    <p className="text-destructive text-xs" role="alert" data-testid="policy-error">
      {error.message}
    </p>
  );
}

function PolicyValuesEditor({
  kind,
  values,
  onChange,
  disabled,
  children,
}: {
  readonly kind: ScalingPolicyKind;
  readonly values: PolicyValues;
  readonly onChange: (next: PolicyValues) => void;
  readonly disabled: boolean;
  readonly children: ReactNode;
}) {
  const definition = POLICY_KINDS[kind];
  const set = (field: keyof PolicyValues) => (next: number) =>
    onChange({ ...values, [field]: next });

  return (
    <>
      <div className="flex flex-col gap-2">
        <Rule label="Scale up" comparison={`${definition.comparison} above`} unit={definition.unit}>
          <Stepper
            name="scale-up threshold"
            value={values.scale_up_above}
            onChange={set('scale_up_above')}
            min={values.scale_down_below + 1}
            disabled={disabled}
            test_id="policy-scale-up"
          />
        </Rule>
        <Rule
          label="Scale down"
          comparison={`${definition.comparison} below`}
          unit={definition.unit}
        >
          <Stepper
            name="scale-down threshold"
            value={values.scale_down_below}
            onChange={set('scale_down_below')}
            min={0}
            max={values.scale_up_above - 1}
            disabled={disabled}
            test_id="policy-scale-down"
          />
        </Rule>
      </div>

      <div className="border-border/70 flex flex-wrap items-center justify-between gap-3 border-t pt-3">
        <div className="flex flex-wrap items-center gap-x-8 gap-y-2">
          <Stepper
            name="min replicas"
            label="Min replicas"
            value={values.min_replicas}
            onChange={set('min_replicas')}
            min={MIN_REPLICAS_FLOOR}
            max={values.max_replicas}
            disabled={disabled}
            test_id="policy-min-replicas"
          />
          <Stepper
            name="max replicas"
            label="Max replicas"
            value={values.max_replicas}
            onChange={set('max_replicas')}
            min={values.min_replicas}
            disabled={disabled}
            test_id="policy-max-replicas"
          />
        </div>
        <div className="flex items-center gap-2">{children}</div>
      </div>
    </>
  );
}

function Rule({
  label,
  comparison,
  unit,
  children,
}: {
  readonly label: string;
  readonly comparison: string;
  readonly unit: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-xs">
      <span className="text-foreground w-24 font-semibold">{label}</span>
      <span className="text-muted-foreground">{comparison}</span>
      {children}
      <span className="text-muted-foreground">{unit}</span>
    </div>
  );
}

const STEP_BUTTON_CLASS =
  'border-border/70 text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground flex size-6 items-center justify-center rounded-[0.375rem] border transition-colors disabled:cursor-not-allowed disabled:opacity-40';

function Stepper({
  name,
  label,
  value,
  onChange,
  min,
  max,
  disabled,
  test_id,
}: {
  readonly name: string;
  readonly label?: string;
  readonly value: number;
  readonly onChange: (next: number) => void;
  readonly min: number;
  readonly max?: number;
  readonly disabled: boolean;
  readonly test_id: string;
}) {
  const at_min = value <= min;
  const at_max = max !== undefined && value >= max;

  return (
    <div className="flex items-center gap-2 text-xs">
      <StepperLabel label={label} />
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          className={STEP_BUTTON_CLASS}
          aria-label={`Decrease ${name}`}
          data-testid={`${test_id}-decrease`}
          disabled={disabled || at_min}
          onClick={() => onChange(value - 1)}
        >
          <MinusIcon className="size-3" strokeWidth={2.2} />
        </button>
        <span
          className="text-foreground w-8 text-center font-mono font-semibold"
          data-testid={`${test_id}-value`}
        >
          {value}
        </span>
        <button
          type="button"
          className={STEP_BUTTON_CLASS}
          aria-label={`Increase ${name}`}
          data-testid={`${test_id}-increase`}
          disabled={disabled || at_max}
          onClick={() => onChange(value + 1)}
        >
          <PlusIcon className="size-3" strokeWidth={2.2} />
        </button>
      </div>
    </div>
  );
}

function StepperLabel({ label }: { readonly label?: string }) {
  if (!label) return null;
  return <span className="text-muted-foreground">{label}</span>;
}
