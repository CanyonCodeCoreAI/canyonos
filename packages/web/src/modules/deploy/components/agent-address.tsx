import { CopyButton } from '@repo/ui/components/copy-button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@repo/ui/shadcn/tooltip';
import { cn } from '@repo/ui/utils';

interface AgentAddressProps {
  readonly address: string;
  readonly className?: string;
  readonly test_id?: string;
  readonly copy_test_id?: string;
  /** Names the copy action in visible text. Omit to keep the compact icon-only button. */
  readonly copy_label?: string;
  /** Off where a Live badge already carries the status dot, as in the project header. */
  readonly show_status_dot?: boolean;
}

// The live agent endpoint: a status dot, the address in mono, and a copy button. Shared by the
// deploy summary card and the project header so both read the same way.
export function AgentAddress({
  address,
  className,
  test_id,
  copy_test_id,
  copy_label,
  show_status_dot = true,
}: AgentAddressProps) {
  return (
    <div className={cn('flex min-w-0 items-center gap-3', className)} data-testid={test_id}>
      {show_status_dot ? (
        <span className="bg-primary size-2 shrink-0 rounded-full" aria-hidden />
      ) : null}
      <TooltipProvider delayDuration={300}>
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="text-foreground min-w-0 flex-1 truncate font-mono text-[0.8125rem]">
              {address}
            </span>
          </TooltipTrigger>
          <TooltipContent>Agent address</TooltipContent>
        </Tooltip>
      </TooltipProvider>
      <CopyButton value={address} label={copy_label} data-testid={copy_test_id} />
    </div>
  );
}
