import { notFound } from '@core/errors';
import { LOG_DOMAINS, logger } from '@core/logger';

import { companiesRepo } from './companies.repo';
import type { CompanyRow } from './companies.repo';
import type { Company, CreateCompanyInput } from './companies.types';

const companyLogger = logger.child({ domain: LOG_DOMAINS.COMPANY });

const toCompany = ({ createdAt, updatedAt, ...rest }: CompanyRow): Company => ({
  ...rest,
  created_at: createdAt,
  updated_at: updatedAt,
});

export const companiesService = {
  async create(input: CreateCompanyInput): Promise<Company> {
    const row = await companiesRepo.create(input);
    companyLogger.info('company created', { companyId: row.id });
    return toCompany(row);
  },

  async get(id: string): Promise<Company> {
    const row = await companiesRepo.findById(id);
    if (!row) throw notFound('companies.not_found', `Company "${id}" was not found`);
    return toCompany(row);
  },

  async list(): Promise<Company[]> {
    const rows = await companiesRepo.list();
    return rows.map(toCompany);
  },
};
