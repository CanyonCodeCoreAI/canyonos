// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';

export const CompanySelectionSchema = z.object({
  company_id: z.string().uuid(),
});
export type CompanySelectionInput = z.infer<typeof CompanySelectionSchema>;

export const CompanyNameSchema = z.object({
  company_name: z.string().trim().min(1),
});
export type CompanyNameInput = z.infer<typeof CompanyNameSchema>;
