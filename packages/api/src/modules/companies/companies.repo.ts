import { desc, eq } from 'drizzle-orm';

import { db } from '@api/db/client';
import { companies } from '@api/db/schema';
import { internalError } from '@core/errors';

import type { CreateCompanyInput } from './companies.types';

export type CompanyRow = typeof companies.$inferSelect;

export const companiesRepo = {
  async create(input: CreateCompanyInput): Promise<CompanyRow> {
    const [row] = await db.insert(companies).values({ name: input.name }).returning();
    if (!row) throw internalError('companies.create_failed', 'Failed to create company');
    return row;
  },

  async findById(id: string): Promise<CompanyRow | undefined> {
    const [row] = await db.select().from(companies).where(eq(companies.id, id)).limit(1);
    return row;
  },

  async list(): Promise<CompanyRow[]> {
    return db.select().from(companies).orderBy(desc(companies.createdAt));
  },
};
