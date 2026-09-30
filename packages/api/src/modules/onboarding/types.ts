import { z } from 'zod';

export const CompanySelectionSchema = z.object({
  company_id: z.string().uuid(),
});
export type CompanySelectionInput = z.infer<typeof CompanySelectionSchema>;

export const CompanyNameSchema = z.object({
  company_name: z.string().trim().min(1),
});
export type CompanyNameInput = z.infer<typeof CompanyNameSchema>;
