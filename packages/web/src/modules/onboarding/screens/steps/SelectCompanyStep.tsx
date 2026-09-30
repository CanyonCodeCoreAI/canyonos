import { zodResolver } from '@hookform/resolvers/zod';
import { useSelector } from '@xstate/react';
import { Building2, Lock } from 'lucide-react';
import { Controller, useForm } from 'react-hook-form';

import { CompanySelectionSchema } from '@canyonos/api/onboarding';
import type { CompanySelectionInput } from '@canyonos/api/onboarding';

import { BackButton } from '@repo/ui/components/back-button';
import { Button } from '@repo/ui/shadcn/button';
import { Label } from '@repo/ui/shadcn/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@repo/ui/shadcn/select';
import type { OnboardingMachineActorRef } from '@/modules/onboarding/onboarding.machine';

export function SelectCompanyStep({ actorRef }: { actorRef: OnboardingMachineActorRef }) {
  const isLoading = useSelector(actorRef, (state) => state.hasTag('loading'));
  const submitError = useSelector(actorRef, (state) => state.context.error);
  const companies = useSelector(actorRef, (state) => state.context.companies);

  const {
    control,
    handleSubmit,
    formState: { errors },
  } = useForm<CompanySelectionInput>({
    resolver: zodResolver(CompanySelectionSchema),
    defaultValues: { company_id: '' },
  });

  const onSubmit = handleSubmit((data) =>
    actorRef.send({ type: 'JOIN', company_id: data.company_id })
  );

  const hasCompanies = companies.length > 0;

  return (
    <div>
      <span className="text-primary mb-2.5 block text-xs font-semibold tracking-wide uppercase">
        Company
      </span>
      <h2 className="text-foreground mb-1.5 text-2xl font-semibold tracking-[-0.015em]">
        Join your company
      </h2>
      <p className="text-muted-foreground mb-6 text-sm">
        Pick the company you belong to, or create a new one.
      </p>

      <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
        <div>
          <Label
            htmlFor="company_id"
            className="text-secondary-foreground mb-1.5 block text-xs font-semibold"
          >
            Company
          </Label>
          <Controller
            control={control}
            name="company_id"
            render={({ field }) => (
              <Select
                value={field.value}
                onValueChange={field.onChange}
                disabled={isLoading || !hasCompanies}
              >
                <SelectTrigger
                  id="company_id"
                  data-testid="company-select"
                  aria-invalid={!!errors.company_id}
                >
                  <SelectValue
                    placeholder={
                      isLoading
                        ? 'Loading companies…'
                        : hasCompanies
                          ? 'Select a company'
                          : 'No companies yet'
                    }
                  />
                </SelectTrigger>
                <SelectContent>
                  {companies.map((company) => (
                    <SelectItem key={company.id} value={company.id}>
                      {company.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          />
          {errors.company_id?.message && (
            <span className="text-destructive mt-1 block text-xs">{errors.company_id.message}</span>
          )}
        </div>

        <div className="min-h-4">
          {submitError && <span className="text-destructive text-xs">{submitError}</span>}
        </div>

        <div className="flex items-center gap-3">
          <BackButton
            onClick={() => actorRef.send({ type: 'GO_BACK' })}
            disabled={isLoading}
            className="border-input text-secondary-foreground hover:bg-muted h-12 rounded-md border px-4"
          />
          <Button
            type="submit"
            className="h-12 flex-1"
            disabled={isLoading || !hasCompanies}
            data-testid="join-company"
          >
            {isLoading ? 'Saving…' : 'Continue'}
          </Button>
        </div>

        <Button
          type="button"
          variant="outline"
          className="h-12"
          disabled={isLoading}
          onClick={() => actorRef.send({ type: 'GO_CREATE' })}
          data-testid="create-company"
        >
          <Building2 className="size-4" />
          Create company
        </Button>
      </form>

      <p className="text-muted-foreground mt-4 flex items-start gap-2 text-xs leading-relaxed">
        <Lock className="text-primary mt-px size-3.5 shrink-0" />
        You'll be linked to this company and share its workspace.
      </p>
    </div>
  );
}
