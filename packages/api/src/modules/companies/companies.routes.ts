import { Elysia } from 'elysia';
import { z } from 'zod';

import { resolveAuth } from '../auth/auth.middleware';
import { companiesService } from './companies.service';
import { CreateCompanySchema } from './companies.types';

const CompanyParams = z.object({ id: z.string().uuid() });

export const companiesRoutes = new Elysia({ prefix: '/companies', name: 'companies.routes' })
  .resolve(async ({ request }) => ({ auth: await resolveAuth(request) }))
  .post('/', ({ body }) => companiesService.create(body), { body: CreateCompanySchema })
  .get('/', () => companiesService.list())
  .get('/:id', ({ params }) => companiesService.get(params.id), { params: CompanyParams });
