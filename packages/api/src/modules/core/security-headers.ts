import { Elysia } from 'elysia';

const HEADERS_TO_REMOVE = ['x-powered-by', 'server'] as const;

export const securityHeaders = () =>
  new Elysia({ name: 'security-headers' }).onBeforeHandle({ as: 'global' }, ({ set }) => {
    set.headers['X-Content-Type-Options'] = 'nosniff';
    for (const h of HEADERS_TO_REMOVE) delete set.headers[h];
  });
