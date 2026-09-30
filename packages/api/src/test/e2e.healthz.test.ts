import { describe, expect, test } from 'bun:test';

import { api, setupE2ETests } from './e2e.setup';

setupE2ETests();

describe('healthz', () => {
  test('returns ok', async () => {
    const { data, error } = await api.healthz.get();
    expect(error).toBeNull();
    expect(data?.status).toBe('ok');
    expect(typeof data?.timestamp).toBe('string');
  });

  test('reports the explicit commit before the Railway commit value', async () => {
    const previousRailwayCommit = process.env.RAILWAY_GIT_COMMIT_SHA;
    const previousLegacyCommit = process.env.GIT_COMMIT_SHA;
    process.env.RAILWAY_GIT_COMMIT_SHA = 'railway-commit';
    process.env.GIT_COMMIT_SHA = 'legacy-commit';

    try {
      const { data, error } = await api.healthz.get();
      expect(error).toBeNull();
      expect(data?.version).toBe('legacy-commit');

      delete process.env.GIT_COMMIT_SHA;
      const fallback = await api.healthz.get();
      expect(fallback.error).toBeNull();
      expect(fallback.data?.version).toBe('railway-commit');
    } finally {
      if (previousRailwayCommit === undefined) delete process.env.RAILWAY_GIT_COMMIT_SHA;
      else process.env.RAILWAY_GIT_COMMIT_SHA = previousRailwayCommit;
      if (previousLegacyCommit === undefined) delete process.env.GIT_COMMIT_SHA;
      else process.env.GIT_COMMIT_SHA = previousLegacyCommit;
    }
  });
});
