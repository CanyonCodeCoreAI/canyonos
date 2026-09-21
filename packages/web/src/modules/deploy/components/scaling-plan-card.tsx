import { LockIcon, SlidersHorizontalIcon } from 'lucide-react';
import { useState } from 'react';
import { Controller } from 'react-hook-form';
import type { UseFormReturn } from 'react-hook-form';

import type { DeployConfig } from '@cc-forge/api/deploy';

import { CardHeading } from '@repo/ui/components/card-heading';
import { Button } from '@repo/ui/shadcn/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader } from '@repo/ui/shadcn/card';
import { Collapsible, CollapsibleContent } from '@repo/ui/shadcn/collapsible';
import { Input } from '@repo/ui/shadcn/input';
import { Label } from '@repo/ui/shadcn/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@repo/ui/shadcn/select';
import { cn } from '@repo/ui/utils';
import {
  LLM_ENDPOINT_OPTIONS,
  LOAD_UNIT_OPTIONS,
  PRIORITY_LEVELS,
  PRIORITY_MAX,
  PRIORITY_MIN,
  PRIORITY_STEP,
} from '@/modules/deploy/deploy.scaling-plan';
import type { ScalingPlanInput } from '@/modules/deploy/deploy.scaling-plan';

const SLIDER_INTERACTION_KEYS = new Set([
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'ArrowDown',
  'Home',
  'End',
  'PageUp',
  'PageDown',
]);

interface ScalingPlanCardProps {
  readonly form: UseFormReturn<ScalingPlanInput>;
  readonly config: DeployConfig;
  readonly is_submitting: boolean;
  /** Runs the analysis. Disabled until the plan is answerable, and after it has been set. */
  readonly onSet: () => void;
  readonly can_set: boolean;
  readonly is_set: boolean;
}

/**
 * The four answers a deploy is planned from. The compute environment reads the same provider list the
 * deploy target card used, so a provider that is not open yet stays disabled here too.
 */
export function ScalingPlanCard({
  form,
  config,
  is_submitting,
  onSet,
  can_set,
  is_set,
}: ScalingPlanCardProps) {
  const {
    register,
    control,
    watch,
    formState: { errors },
  } = form;

  // The load is the question the rest depend on: what to optimise for and where to run it only mean
  // something once there is a volume to plan against. Until then they stay shut rather than
  // inviting answers that would be read against nothing.
  const expected_load = watch('expected_load');
  const load_set = Number.isInteger(expected_load) && expected_load > 0;

  // The slider always holds a value, so "answered" here means touched rather than non-empty. Tracked
  // locally rather than through the form's dirty state, which would forget a reader who dragged the
  // thumb and settled back on the default they started from.
  const [priority_touched, setPriorityTouched] = useState(false);
  const targets_revealed = load_set && priority_touched;

  return (
    <Card data-testid="deploy-scaling-plan-card">
      <CardHeader>
        <CardHeading icon={SlidersHorizontalIcon}>Scaling policy</CardHeading>
        <CardDescription>
          Tell us the traffic to plan for and what to optimise for, and we size the deployment
          around it.
        </CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col gap-6">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="deploy-expected-load">
            What load do you expect this workflow to handle?
          </Label>
          {/* Bottom-aligned so the unit caption can sit above the number without pushing the
              dropdown out of line with it. */}
          <div className="flex items-end gap-2">
            <div className="flex flex-col gap-1">
              <span className="text-accent-foreground text-[0.6875rem] font-semibold tracking-[0.05em] uppercase">
                Queries
              </span>
              <Input
                id="deploy-expected-load"
                type="number"
                inputMode="numeric"
                min={1}
                step={1}
                placeholder="e.g. 120"
                disabled={is_submitting}
                aria-invalid={!!errors.expected_load}
                className="bg-accent border-primary/40 placeholder:text-accent-foreground/70 max-w-[10rem]"
                data-testid="deploy-expected-load"
                {...register('expected_load', { valueAsNumber: true })}
              />
            </div>
            <Controller
              control={control}
              name="load_unit"
              render={({ field }) => (
                <Select value={field.value} onValueChange={field.onChange} disabled={is_submitting}>
                  <SelectTrigger
                    aria-label="Load unit"
                    className="max-w-[11rem]"
                    data-testid="deploy-load-unit"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {LOAD_UNIT_OPTIONS.map((option) => (
                      <SelectItem
                        key={option.value}
                        value={option.value}
                        data-testid={`deploy-load-unit-option-${option.value}`}
                      >
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            />
          </div>
          {errors.expected_load?.message ? (
            <span className="text-destructive text-xs" role="alert" data-testid="deploy-load-error">
              {errors.expected_load.message}
            </span>
          ) : !load_set ? (
            <span className="text-accent-foreground text-xs" data-testid="deploy-load-hint">
              Enter the expected load to choose the rest.
            </span>
          ) : null}
        </div>

        {/* Driven by the answer, not by a trigger: these questions appear once there is a volume to
            read them against. Dimming them instead made the whole card look inert. */}
        <Collapsible open={load_set}>
          <CollapsibleContent className="data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down overflow-hidden">
            <div className="flex min-w-0 flex-col gap-6" data-testid="deploy-plan-choices">
              <Controller
                control={control}
                name="priority"
                render={({ field }) => (
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="deploy-priority">
                      What do you want to prioritise for this workflow?
                    </Label>
                    {/* A native range: one control, keyboard support for free, and no slider primitive
                    in the design system to borrow. The ends are labelled because the number alone
                    says nothing about which direction is which. */}
                    <input
                      id="deploy-priority"
                      type="range"
                      min={PRIORITY_MIN}
                      max={PRIORITY_MAX}
                      step={PRIORITY_STEP}
                      value={field.value}
                      onPointerDown={() => setPriorityTouched(true)}
                      onKeyDown={(event) => {
                        if (SLIDER_INTERACTION_KEYS.has(event.key)) setPriorityTouched(true);
                      }}
                      onChange={(event) => {
                        setPriorityTouched(true);
                        field.onChange(Number(event.target.value));
                      }}
                      aria-valuetext={`${field.value} of ${PRIORITY_MAX} towards most economical`}
                      className="accent-primary h-2 w-full cursor-pointer rounded-full disabled:cursor-not-allowed"
                      data-testid="deploy-priority"
                    />
                    {/* The detents made visible. `px-2` insets them by roughly half the thumb, which is
                    the travel the thumb's centre actually has. Decorative: the value is already
                    announced on the input itself. */}
                    <div className="flex justify-between px-2" aria-hidden>
                      {PRIORITY_LEVELS.map((level) => (
                        <span
                          key={level}
                          className={cn(
                            'w-px rounded-full',
                            level === field.value ? 'bg-primary h-2' : 'bg-border h-1.5'
                          )}
                        />
                      ))}
                    </div>

                    <div className="text-muted-foreground flex items-center justify-between text-xs">
                      <span>Best latency</span>
                      <span>Most economical</span>
                    </div>
                  </div>
                )}
              />
            </div>
          </CollapsibleContent>
        </Collapsible>

        {/* Second reveal: where it runs is only worth asking once the reader has said what to
            optimise for. */}
        <Collapsible open={targets_revealed}>
          <CollapsibleContent className="data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down overflow-hidden">
            <div
              className="grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2"
              data-testid="deploy-plan-targets"
            >
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="deploy-compute-environment">Compute environment</Label>
                <Select defaultValue={String(config.provider)} disabled={is_submitting}>
                  <SelectTrigger
                    id="deploy-compute-environment"
                    data-testid="deploy-provider-select"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {config.providers.map((option) => (
                      <SelectItem
                        key={option.id}
                        value={String(option.id)}
                        disabled={!option.enabled}
                        data-testid={`deploy-provider-option-${option.id}`}
                      >
                        <span className="flex items-center gap-2">
                          {option.name}
                          {!option.enabled && (
                            <>
                              <LockIcon className="size-3.5" aria-hidden />
                              <span className="sr-only">coming soon</span>
                            </>
                          )}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="deploy-llm-endpoint">LLM endpoint</Label>
                <Controller
                  control={control}
                  name="llm_endpoint"
                  render={({ field }) => (
                    <Select
                      value={field.value}
                      onValueChange={field.onChange}
                      disabled={is_submitting}
                    >
                      <SelectTrigger id="deploy-llm-endpoint" data-testid="deploy-llm-endpoint">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {LLM_ENDPOINT_OPTIONS.map((option) => (
                          <SelectItem
                            key={option.value}
                            value={option.value}
                            data-testid={`deploy-llm-endpoint-option-${option.value}`}
                          >
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                />
              </div>
            </div>
          </CollapsibleContent>
        </Collapsible>
      </CardContent>

      <CardFooter className="justify-end gap-3">
        {is_set ? (
          <span className="text-muted-foreground text-xs" data-testid="deploy-plan-set-hint">
            Change an answer to plan again.
          </span>
        ) : null}
        {/* `type="button"`: this sits inside the deploy form, and a bare button would submit it. */}
        <Button
          type="button"
          size="sm"
          onClick={onSet}
          disabled={!can_set || is_set || is_submitting}
          data-testid="deploy-plan-set"
        >
          Set
        </Button>
      </CardFooter>
    </Card>
  );
}
