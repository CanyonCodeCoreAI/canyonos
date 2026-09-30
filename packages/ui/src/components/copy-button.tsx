import { CheckIcon, CopyIcon } from 'lucide-react';
import { useState } from 'react';
import type { ComponentProps, MouseEvent } from 'react';

import { cn } from '../lib/utils';
import { Button } from '../shadcn/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../shadcn/tooltip';

type CopyState = 'idle' | 'copied' | 'failed';

interface CopyButtonProps extends ComponentProps<typeof Button> {
  value: string;
  tooltip?: string;
  /** Renders visible text beside the icon. Omit for the compact icon-only button. */
  label?: string;
}

const OUTCOME_TOOLTIP: Record<Exclude<CopyState, 'idle'>, string> = {
  copied: 'Copied!',
  failed: 'Copy failed',
};

export function CopyButton({
  value,
  tooltip = 'Copy',
  label,
  className,
  ...props
}: CopyButtonProps) {
  const [state, setState] = useState<CopyState>('idle');
  const accessibleLabel = state === 'idle' ? (label ?? tooltip) : OUTCOME_TOOLTIP[state];

  async function copy(event: MouseEvent<HTMLButtonElement>) {
    // The button can sit above a stretched row link; keep the click from following it.
    event.preventDefault();
    event.stopPropagation();
    try {
      await navigator.clipboard.writeText(value);
      setState('copied');
    } catch {
      setState('failed');
    }
    setTimeout(() => setState('idle'), 2000);
  }

  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip open={state === 'idle' ? undefined : true}>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size={label ? 'sm' : 'icon'}
            onClick={copy}
            aria-label={accessibleLabel}
            className={cn(
              label ? 'px-2.5' : 'size-8',
              state === 'failed' && 'text-destructive hover:text-destructive',
              className
            )}
            data-state={state}
            {...props}
          >
            {state === 'copied' ? <CheckIcon className="text-primary" /> : <CopyIcon />}
            {label ? <span>{label}</span> : null}
          </Button>
        </TooltipTrigger>
        {/* The visible text already names the action; the tooltip is only worth showing for the
            icon-only button, or to report the outcome after a click. */}
        {label && state === 'idle' ? null : <TooltipContent>{accessibleLabel}</TooltipContent>}
      </Tooltip>
    </TooltipProvider>
  );
}
