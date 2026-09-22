import { RotateCcwIcon } from 'lucide-react';

import { Button } from '@repo/ui/shadcn/button';
import { Input } from '@repo/ui/shadcn/input';
import { cn } from '@repo/ui/utils';
import {
  LLM_ENDPOINT_OPTIONS,
  LOAD_UNIT_OPTIONS,
  posture,
  PRIORITY_MAX,
  PRIORITY_MIN,
  PRIORITY_STEP,
} from '@/modules/deploy/deploy.scaling-plan';
import type { EmulationPolicy } from '@/modules/deploy/deploy.emulation';

/**
 * The policy being emulated, at the top of the run that reads it.
 *
 * Editable in place rather than sending the reader back a screen: the whole point of watching this is
 * to find out whether the answers hold, and finding out means changing one and watching again. Reset
 * puts back what the policy screen set, so an experiment is never a one-way door.
 *
 * Every edit restarts both lanes. A run that carried its history across a change of load would be
 * showing two policies at once.
 */
export function EmulationPolicyBar({
  policy,
  baseline,
  onChange,
  onReset,
}: {
  readonly policy: EmulationPolicy;
  /** What the scaling policy screen set, which Reset returns to. */
  readonly baseline: EmulationPolicy;
  readonly onChange: (policy: EmulationPolicy) => void;
  readonly onReset: () => void;
}) {
  const changed =
    policy.expected_load !== baseline.expected_load ||
    policy.load_unit !== baseline.load_unit ||
    policy.priority !== baseline.priority ||
    policy.llm_endpoint !== baseline.llm_endpoint;

  return (
    <section
      className="border-border bg-card flex flex-wrap items-end gap-x-6 gap-y-4 rounded-2xl border p-4 shadow-xs"
      aria-label="Policy being emulated"
      data-testid="emulation-policy"
    >
      <Field label="Expected load">
        <div className="flex items-center gap-2">
          <Input
            type="number"
            min={1}
            value={policy.expected_load}
            onChange={(event) => {
              const next = Number(event.target.value);
              // A cleared or nonsense field would divide the arrivals by nothing, so it holds.
              if (Number.isFinite(next) && next >= 1) {
                onChange({ ...policy, expected_load: Math.round(next) });
              }
            }}
            className="h-8 w-24 font-mono text-[0.8125rem] tabular-nums"
            aria-label="Expected load"
            data-testid="emulation-policy-load"
          />
          <select
            value={policy.load_unit}
            onChange={(event) =>
              onChange({ ...policy, load_unit: event.target.value as EmulationPolicy['load_unit'] })
            }
            className="border-input bg-background h-8 rounded-md border px-2 text-[0.8125rem]"
            aria-label="Load unit"
            data-testid="emulation-policy-unit"
          >
            {LOAD_UNIT_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
      </Field>

      <Field label="Priority" hint={posture(policy.priority)}>
        <input
          type="range"
          min={PRIORITY_MIN}
          max={PRIORITY_MAX}
          step={PRIORITY_STEP}
          value={policy.priority}
          onChange={(event) => onChange({ ...policy, priority: Number(event.target.value) })}
          className="accent-primary h-8 w-40"
          aria-label="Priority"
          data-testid="emulation-policy-priority"
        />
      </Field>

      <Field label="LLM endpoint">
        <select
          value={policy.llm_endpoint}
          onChange={(event) =>
            onChange({
              ...policy,
              llm_endpoint: event.target.value as EmulationPolicy['llm_endpoint'],
            })
          }
          className="border-input bg-background h-8 rounded-md border px-2 text-[0.8125rem]"
          aria-label="LLM endpoint"
          data-testid="emulation-policy-endpoint"
        >
          {LLM_ENDPOINT_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </Field>

      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={onReset}
        disabled={!changed}
        className="ml-auto"
        data-testid="emulation-policy-reset"
      >
        <RotateCcwIcon aria-hidden />
        Reset
      </Button>
    </section>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  readonly label: string;
  readonly hint?: string;
  readonly children: React.ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <span className="text-muted-foreground text-[0.65625rem] font-semibold tracking-[0.05em] uppercase">
        {label}
      </span>
      {children}
      {hint === undefined ? null : (
        <span className={cn('text-muted-foreground truncate text-[0.6875rem]')}>{hint}</span>
      )}
    </div>
  );
}
