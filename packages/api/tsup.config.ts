import { defineConfig } from 'tsup';

export default defineConfig((options) => ({
  entry: {
    index: 'src/sdk/index.ts',
    client: 'src/sdk/client.ts',
    core: 'src/sdk/core.ts',
    auth: 'src/sdk/auth.ts',
    companies: 'src/sdk/companies.ts',
    onboarding: 'src/sdk/onboarding.ts',
    resources: 'src/sdk/resources.ts',
    projects: 'src/sdk/projects.ts',
    requests: 'src/sdk/requests.ts',
    metrics: 'src/sdk/metrics.ts',
    prompts: 'src/sdk/prompts.ts',
    scaling: 'src/sdk/scaling.ts',
  },
  format: ['esm'],
  dts: true,
  splitting: true,
  clean: !options.watch,
  outDir: 'dist',
  external: ['zod'],
}));
