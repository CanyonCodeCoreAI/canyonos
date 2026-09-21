import { zodResolver } from '@hookform/resolvers/zod';
import { useSelector } from '@xstate/react';
import { Lock } from 'lucide-react';
import { useForm } from 'react-hook-form';

import { CompanyNameSchema } from '@cc-forge/api/onboarding';
import type { CompanyNameInput } from '@cc-forge/api/onboarding';

import { BackButton } from '@repo/ui/components/back-button';
import { Button } from '@repo/ui/shadcn/button';
import { Input } from '@repo/ui/shadcn/input';
import { Label } from '@repo/ui/shadcn/label';
import type { OnboardingMachineActorRef } from '@/modules/onboarding/onboarding.machine';

export function CreateCompanyStep({ actorRef }: { actorRef: OnboardingMachineActorRef }) {
  const isLoading = useSelector(actorRef, (state) => state.hasTag('loading'));
  const submitError = useSelector(actorRef, (state) => state.context.error);

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<CompanyNameInput>({
    resolver: zodResolver(CompanyNameSchema),
    defaultValues: { company_name: '' },
  });

  const onSubmit = handleSubmit((data) =>
    actorRef.send({ type: 'CREATE', company_name: data.company_name })
  );

  return (
    <div>
      <span className="text-primary mb-2.5 block text-xs font-semibold tracking-wide uppercase">
        Company
      </span>
      <h2 className="text-foreground mb-1.5 text-2xl font-semibold tracking-[-0.015em]">
        Create your company
      </h2>
      <p className="text-muted-foreground mb-6 text-sm">
        Name your company to provision a fresh workspace.
      </p>

      <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
        <div>
          <Label
            htmlFor="company_name"
            className="text-secondary-foreground mb-1.5 block text-xs font-semibold"
          >
            Company name
          </Label>
          <Input
            id="company_name"
            autoFocus
            placeholder="Acme Robotics"
            disabled={isLoading}
            aria-invalid={!!errors.company_name}
            data-testid="company-name"
            {...register('company_name')}
          />
          {errors.company_name?.message && (
            <span className="text-destructive mt-1 block text-xs">
              {errors.company_name.message}
            </span>
          )}
        </div>

        <div className="min-h-4">
          {submitError && <span className="text-destructive text-xs">{submitError}</span>}
        </div>

        <div className="flex items-center gap-3">
          <BackButton
            onClick={() => actorRef.send({ type: 'GO_SELECT' })}
            disabled={isLoading}
            className="border-input text-secondary-foreground hover:bg-muted h-12 rounded-md border px-4"
          />
          <Button
            type="submit"
            className="h-12 flex-1"
            disabled={isLoading}
            data-testid="submit-company"
          >
            {isLoading ? 'Creating…' : 'Create company'}
          </Button>
        </div>
      </form>

      <p className="text-muted-foreground mt-4 flex items-start gap-2 text-xs leading-relaxed">
        <Lock className="text-primary mt-px size-3.5 shrink-0" />
        Your details are encrypted and used only to provision your tenant.
      </p>
    </div>
  );
}
