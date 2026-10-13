import { Elysia } from 'elysia';

import { register_project_at } from './canyonos.bootstrap';
import { RegisteredProjectSchema, RegisterProjectBody } from './canyonos.types';

// Temporary: applied now so multi-project dashboards work without blocking the flow; revisit
// with the project-key design in CAN-521 (the api should not hold per-project Redis addresses).
// Unauthenticated because the caller is the CLI on the deploy host, which holds no dashboard
// token. The body carries only a port: the api connects to its own configured Redis host, never
// one the caller names, and takes the project id from the identity a controller wrote there.
export const canyonosRoutes = new Elysia({ prefix: '/canyonos', name: 'canyonos.routes' }).post(
  '/projects',
  ({ body }) => register_project_at(body.redis_port),
  {
    body: RegisterProjectBody,
    response: { 200: RegisteredProjectSchema },
    detail: { tags: ['CanyonOS'], summary: 'Register the project a controller runs' },
  }
);
