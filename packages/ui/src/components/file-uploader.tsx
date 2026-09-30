import * as React from 'react';

import { cn } from '../lib/utils';

interface FileUploaderProps extends React.ComponentProps<'div'> {
  inputProps: React.ComponentPropsWithRef<'input'>;
  isDragging?: boolean;
}

function FileUploader({
  inputProps,
  isDragging,
  className,
  children,
  ref,
  ...rootProps
}: FileUploaderProps) {
  return (
    <div
      ref={ref}
      data-dragging={isDragging || undefined}
      className={cn(
        'border-input bg-background ease-snappy relative flex w-full cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed px-6 py-10 text-center text-sm transition-[color,background-color,border-color] duration-150 outline-none',
        'hover:border-primary/50 hover:bg-muted/40 active:bg-muted/60',
        'focus-visible:border-primary focus-visible:ring-primary/30 focus-visible:ring-[3px]',
        'data-[dragging=true]:border-primary data-[dragging=true]:bg-accent',
        'aria-disabled:pointer-events-none aria-disabled:cursor-not-allowed aria-disabled:opacity-60',
        className
      )}
      {...rootProps}
    >
      <input {...inputProps} className="sr-only" />
      {children}
      <span aria-live="polite" className="sr-only">
        {isDragging ? 'File over drop zone, release to upload' : ''}
      </span>
    </div>
  );
}

export { FileUploader };
export type { FileUploaderProps };
