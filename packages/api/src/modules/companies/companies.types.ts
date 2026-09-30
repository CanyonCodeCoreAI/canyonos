import { z } from 'zod';

export const CompanySchema = z.object({
  id: z.string(),
  name: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type Company = z.infer<typeof CompanySchema>;

export const CreateCompanySchema = z.object({
  name: z.string().trim().min(1),
});
export type CreateCompanyInput = z.infer<typeof CreateCompanySchema>;
