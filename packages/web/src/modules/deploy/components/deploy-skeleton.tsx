import { Card, CardContent, CardHeader } from '@repo/ui/shadcn/card';
import { Skeleton } from '@repo/ui/shadcn/skeleton';
import { STARTING_CONFIG_FIELDS } from '@/modules/deploy/deploy.starting-config';

const skeletonTone = 'bg-secondary';

export function DeploySkeleton() {
  return (
    <main className="flex min-h-0 flex-1 flex-col" data-testid="deploy-loading">
      <div className="mx-auto flex h-fit w-full max-w-[640px] flex-col gap-6 px-7 pt-6 pb-6">
        <div className="flex flex-col gap-2">
          <Skeleton className={`${skeletonTone} h-8 w-72`} />
          <Skeleton className={`${skeletonTone} h-4 w-96 max-w-full`} />
        </div>

        <Card>
          <CardHeader>
            <Skeleton className={`${skeletonTone} h-4 w-40`} />
            <Skeleton className={`${skeletonTone} h-3 w-full max-w-96`} />
          </CardHeader>
          <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {STARTING_CONFIG_FIELDS.map((field) => (
              <div key={field.name} className="flex flex-col gap-1.5">
                <Skeleton className={`${skeletonTone} h-3.5 w-28`} />
                <Skeleton className={`${skeletonTone} h-9 w-full`} />
              </div>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex-row items-center justify-between gap-2">
            <Skeleton className={`${skeletonTone} h-4 w-28`} />
            <Skeleton className={`${skeletonTone} h-3 w-24`} />
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Skeleton className={`${skeletonTone} h-3.5 w-32`} />
              <Skeleton className={`${skeletonTone} h-9 w-full`} />
            </div>
          </CardContent>
        </Card>

        <div className="flex items-center justify-between gap-4">
          <Skeleton className={`${skeletonTone} h-4 w-44`} />
          <Skeleton className={`${skeletonTone} h-9 w-40`} />
        </div>
      </div>
    </main>
  );
}
