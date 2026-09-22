import { GaugeIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { UseFormReturn } from 'react-hook-form';

import { CardHeading } from '@repo/ui/components/card-heading';
import { Button } from '@repo/ui/shadcn/button';
import { Card, CardContent, CardDescription, CardHeader } from '@repo/ui/shadcn/card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@repo/ui/shadcn/collapsible';
import { Input } from '@repo/ui/shadcn/input';
import { Label } from '@repo/ui/shadcn/label';
import { STARTING_CONFIG_FIELDS } from '@/modules/deploy/deploy.starting-config';
import type { StartingConfigInput } from '@/modules/deploy/deploy.starting-config';

interface StartingConfigCardProps {
  form: UseFormReturn<StartingConfigInput>;
  is_submitting: boolean;
}

const FIELD_MINIMUMS = new Map(STARTING_CONFIG_FIELDS.map((field) => [field.name, field.min]));

/**
 * The fleet the deploy starts with, as the analysis leaves it.
 *
 * Closed on arrival: the reader has just answered the plan, and these four numbers are the answer to
 * it rather than another question. Opening them is how you disagree with the analysis.
 */
export function StartingConfigCard({ form, is_submitting }: StartingConfigCardProps) {
  const [open, setOpen] = useState(false);
  const {
    register,
    watch,
    formState: { errors, submitCount },
  } = form;

  const values = watch();
  const has_errors = Object.keys(errors).length > 0;

  const shown = (name: (typeof STARTING_CONFIG_FIELDS)[number]['name']) =>
    Number.isFinite(values[name]) ? values[name] : FIELD_MINIMUMS.get(name)!;

  useEffect(() => {
    if (submitCount > 0 && has_errors) setOpen(true);
  }, [submitCount, has_errors]);

  return (
    <Card data-testid="deploy-starting-config-card">
      <Collapsible open={open} onOpenChange={setOpen}>
        <CardHeader className="flex-row items-center justify-between gap-4 pb-5">
          <div className="flex min-w-0 flex-col gap-1.5">
            <CardHeading icon={GaugeIcon}>Starting Configuration</CardHeading>
            <CardDescription>
              {/* The summary is the point of a closed card: the numbers without the fields. */}
              <span data-testid="deploy-starting-config-summary" className="font-mono">
                {shown('starting_cpu_instances')}–{shown('max_cpu_instances')} CPU ·{' '}
                {shown('starting_gpu_instances')}–{shown('max_gpu_instances')} GPU
              </span>
            </CardDescription>
          </div>
          {/* The pill, not the whole header, is the control: a header-sized hit area invites the
              click but says nothing about what it does.

              Canyon green light (`--accent`) rather than the solid brand green: this is a secondary
              action sitting on a screen whose primary action is a solid-green Deploy, and two solid
              greens would leave neither reading as the main move. Deliberately not the brand green at
              half strength — that is what every disabled control in the app looks like. */}
          <CollapsibleTrigger asChild>
            <Button
              type="button"
              size="sm"
              aria-expanded={open}
              className="bg-accent text-accent-foreground hover:bg-accent/70 shrink-0 rounded-full"
              data-testid="deploy-starting-config-toggle"
            >
              {open ? 'Done' : 'Edit'}
            </Button>
          </CollapsibleTrigger>
        </CardHeader>

        <CollapsibleContent className="data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down overflow-hidden">
          <CardContent className="grid grid-cols-1 gap-4 pt-0 sm:grid-cols-2">
            {STARTING_CONFIG_FIELDS.map((field) => {
              const input_id = `deploy-${field.name}`;
              const error = errors[field.name];

              return (
                <div key={field.name} className="flex flex-col gap-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <Label htmlFor={input_id}>{field.label}</Label>
                    <span className="text-muted-foreground font-mono text-xs">
                      min {field.min} · max {field.max}
                    </span>
                  </div>
                  <Input
                    id={input_id}
                    type="number"
                    inputMode="numeric"
                    min={field.min}
                    max={field.max}
                    step={1}
                    disabled={is_submitting}
                    aria-invalid={!!error}
                    data-testid={`deploy-starting-config-input-${field.name}`}
                    {...register(field.name, { valueAsNumber: true })}
                  />
                  {error?.message && (
                    <span
                      className="text-destructive text-xs"
                      role="alert"
                      data-testid={`deploy-starting-config-error-${field.name}`}
                    >
                      {error.message}
                    </span>
                  )}
                </div>
              );
            })}
          </CardContent>
        </CollapsibleContent>
      </Collapsible>
    </Card>
  );
}
