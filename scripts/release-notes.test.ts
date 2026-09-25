import { describe, expect, test } from 'bun:test';

import {
  composePackageChangelog,
  conventionalScopes,
  deduplicateIssues,
  deduplicatePullRequests,
  extractCanIdentifiers,
  findShippedPackages,
  isInternalPullRequest,
  packageForTag,
  packagesForPullRequest,
  packagesTouchedBy,
  pickPreviousRelease,
  queryLinearIssues,
  readManifestVersion,
  releaseLine,
  runReleaseNotesPipeline,
} from './release-notes';
import type {
  FallbackPullRequest,
  LinearIssue,
  PipelineDependencies,
  PullRequest,
  Release,
} from './release-notes';

const pullRequest = (overrides: Partial<PullRequest> = {}): PullRequest => ({
  number: 42,
  url: 'https://github.com/CanyonCodeCoreAI/canyonos/pull/42',
  title: 'Improve deploy output CAN-42',
  body: null,
  headRefName: 'felipea/can-42-deploy-output',
  mergedAt: '2026-09-10T00:00:00Z',
  author: 'felipea',
  ...overrides,
});

const issue = (overrides: Partial<LinearIssue> = {}): LinearIssue => ({
  identifier: 'CAN-42',
  title: 'Improve deploy output',
  description: 'A user-visible CLI update.',
  state: { name: 'Done', type: 'completed' },
  labels: ['cli'],
  project: { name: 'Platform' },
  cycle: { name: 'September', number: 12 },
  ...overrides,
});

const pyproject = (version: string) => `[project]\nname = "canyonos"\nversion = "${version}"\n`;
const packageJson = (version: string) => JSON.stringify({ name: 'web', version });

const manifests: Record<string, Record<string, string>> = {
  'canyonos-v1.0.0': {
    'packages/cli/pyproject.toml': pyproject('0.1.730'),
    'packages/core/pyproject.toml': pyproject('0.1.0'),
    'packages/api/package.json': packageJson('0.1.0'),
    'packages/web/package.json': packageJson('0.1.0'),
  },
  'canyonos-v1.1.0': {
    'packages/cli/pyproject.toml': pyproject('0.1.731'),
    'packages/core/pyproject.toml': pyproject('0.2.0'),
    'packages/api/package.json': packageJson('0.1.0'),
    'packages/web/package.json': packageJson('0.1.0'),
  },
};

function dependencies(overrides: Partial<PipelineDependencies> = {}) {
  const files = new Map<string, string>();
  const calls: {
    linear: number;
    claude: Array<{
      packageName: string;
      issues: string[];
      fallbackPullRequests: FallbackPullRequest[];
    }>;
  } = { linear: 0, claude: [] };
  const base: PipelineDependencies = {
    findPreviousRelease: async () => ({
      tagName: 'canyonos-v1.0.0',
      draft: false,
      prerelease: false,
      publishedAt: '2026-09-18T00:00:00Z',
    }),
    isAncestor: async () => true,
    readFileAt: async (ref, path) => manifests[ref]?.[path] ?? null,
    listRangeCommits: async () => ['commit-a'],
    listAssociatedPullRequests: async () => [pullRequest()],
    listPullRequestFiles: async () => ['packages/cli/src/canyonos/deploy.py'],
    queryLinearIssues: async () => {
      calls.linear += 1;
      return [issue()];
    },
    generateClaudeNotes: async (packageName, issues, fallbackPullRequests) => {
      calls.claude.push({
        packageName,
        issues: issues.map((entry) => entry.identifier),
        fallbackPullRequests,
      });
      return `### Improved\n\n- ${packageName} change.`;
    },
    writeFile: async (path, content) => {
      files.set(path, content);
    },
  };
  return { dependencies: { ...base, ...overrides }, files, calls };
}

const options = {
  targetTag: 'canyonos-v1.1.0',
  repository: 'CanyonCodeCoreAI/canyonos',
  outputDirectory: '/output',
};

describe('release-note validation', () => {
  test('extracts identifiers from the title and head branch', () => {
    expect(
      extractCanIdentifiers(pullRequest({ title: 'Improve CAN-12', headRefName: 'feature/cAn-34' }))
    ).toEqual(['CAN-12', 'CAN-34']);
  });

  test('extracts body identifiers only after a closing keyword', () => {
    const withBody = (body: string) =>
      extractCanIdentifiers(pullRequest({ title: 'Improve', headRefName: 'feature/x', body }));

    expect(withBody('Fixes CAN-419')).toEqual(['CAN-419']);
    expect(withBody('closes: can-7\n\nResolved CAN-8, CAN-9 and CAN-10')).toEqual([
      'CAN-10',
      'CAN-7',
      'CAN-8',
      'CAN-9',
    ]);
    expect(
      withBody('Fixes https://linear.app/canyon-code/issue/CAN-419/check-release-notes')
    ).toEqual(['CAN-419']);
    expect(withBody('Completes [CAN-5](https://linear.app/canyon-code/issue/CAN-5/x)')).toEqual([
      'CAN-5',
    ]);
    expect(withBody('Related to CAN-56, follow-up of CAN-57. Prefix fixing nothing.')).toEqual([]);
    expect(withBody('Hotfixes CAN-58')).toEqual([]);
  });

  test('deduplicates associated pull requests and Linear issues', () => {
    expect(
      deduplicatePullRequests([
        pullRequest({ number: 2 }),
        pullRequest({ number: 2, title: 'Later response' }),
        pullRequest({ number: 1 }),
        pullRequest({ number: 3, mergedAt: null }),
      ]).map((entry) => entry.number)
    ).toEqual([1, 2]);
    expect(deduplicateIssues([issue(), issue({ identifier: 'can-42' })])).toHaveLength(1);
  });

  test('looks up each exact Linear identifier with the singular issue query', async () => {
    const requests: Array<{ query: string; variables: { identifier?: string } }> = [];
    const fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as (typeof requests)[number];
      requests.push(request);
      const identifier = request.variables.identifier;
      return new Response(
        JSON.stringify({
          data: { issue: { ...issue(), identifier, labels: { nodes: [{ name: 'cli' }] } } },
        })
      );
    };

    const issues = await queryLinearIssues(['CAN-42', 'CAN-43'], {
      apiKey: 'test-key',
      fetch: fetch as typeof globalThis.fetch,
    });

    expect(requests.map((request) => request.variables.identifier)).toEqual(['CAN-42', 'CAN-43']);
    expect(requests.every((request) => request.query.includes('issue(id: $identifier)'))).toBe(
      true
    );
    expect(issues.map((entry) => entry.identifier)).toEqual(['CAN-42', 'CAN-43']);
  });
});

describe('release lines', () => {
  const release = (tagName: string, publishedAt: string, flags: Partial<Release> = {}) => ({
    tagName,
    draft: false,
    prerelease: false,
    publishedAt,
    ...flags,
  });

  test('reads the release line from the tag prefix', () => {
    expect(releaseLine('cli-v0.1.730')).toBe('cli-');
    expect(releaseLine('canyonos-v1.1.0')).toBe('canyonos-');
  });

  test('picks the latest earlier release on the same release line', () => {
    const target = release('canyonos-v1.1.0', '2026-09-25T00:00:00Z');

    const previous = pickPreviousRelease(target, [
      release('canyonos-v0.9.0', '2026-09-11T00:00:00Z'),
      release('canyonos-v1.0.0', '2026-09-18T00:00:00Z'),
      release('cli-v0.1.731', '2026-09-24T00:00:00Z'),
      release('canyonos-v1.1.0-rc.1', '2026-09-24T00:00:00Z', { prerelease: true }),
      target,
      release('canyonos-v1.2.0', '2026-10-02T00:00:00Z'),
    ]);

    expect(previous.tagName).toBe('canyonos-v1.0.0');
  });

  test('compares a draft with the latest published release on its line', () => {
    const previous = pickPreviousRelease({ tagName: 'canyonos-v1.1.0', publishedAt: null }, [
      release('canyonos-v0.9.0', '2026-09-11T00:00:00Z'),
      release('canyonos-v1.0.0', '2026-09-18T00:00:00Z'),
      release('cli-v0.1.731', '2026-09-24T00:00:00Z'),
    ]);

    expect(previous.tagName).toBe('canyonos-v1.0.0');
  });

  test('fails when the release line has no earlier release', () => {
    const target = release('canyonos-v1.1.0', '2026-09-25T00:00:00Z');

    expect(() =>
      pickPreviousRelease(target, [release('cli-v0.1.0', '2026-09-01T00:00:00Z')])
    ).toThrow('No previous published release exists before canyonos-v1.1.0.');
  });
});

describe('shipped packages', () => {
  test('reads versions from pyproject and package.json manifests', () => {
    expect(readManifestVersion('packages/cli/pyproject.toml', pyproject('0.1.731'))).toBe(
      '0.1.731'
    );
    expect(readManifestVersion('packages/web/package.json', packageJson('0.2.0'))).toBe('0.2.0');
  });

  test('ships only the packages whose version changed', async () => {
    const shipped = await findShippedPackages(
      'canyonos-v1.0.0',
      'canyonos-v1.1.0',
      async (ref, path) => manifests[ref]?.[path] ?? null
    );

    expect(
      shipped.map(({ name, version, previousVersion }) => [name, version, previousVersion])
    ).toEqual([
      ['CLI', '0.1.731', '0.1.730'],
      ['Core', '0.2.0', '0.1.0'],
    ]);
  });

  test('assigns shared UI changes to the web package', async () => {
    const shipped = await findShippedPackages(
      'canyonos-v1.0.0',
      'canyonos-v1.1.0',
      async (ref, path) =>
        path === 'packages/web/package.json' && ref === 'canyonos-v1.1.0'
          ? packageJson('0.2.0')
          : (manifests[ref]?.[path] ?? null)
    );

    expect(
      packagesTouchedBy(['packages/ui/src/button.tsx', 'README.md'], shipped).map(
        (entry) => entry.name
      )
    ).toEqual(['Web']);
  });
});

describe('pull request classification', () => {
  test('treats CI, chore, build, test, docs, style and refactor pull requests as internal', () => {
    expect(isInternalPullRequest({ title: 'ci(dashboard): release the images' })).toBe(true);
    expect(isInternalPullRequest({ title: 'chore: point URLs at the renamed repo' })).toBe(true);
    expect(isInternalPullRequest({ title: 'refactor!: move the loader' })).toBe(true);
    expect(isInternalPullRequest({ title: 'feat(cli): add --version' })).toBe(false);
    expect(isInternalPullRequest({ title: 'CLI fails to start' })).toBe(false);
  });

  test('reads conventional commit scopes', () => {
    expect(conventionalScopes('feat(cli): add --version')).toEqual(['cli']);
    expect(conventionalScopes('fix(core, api)!: guard the loop')).toEqual(['core', 'api']);
    expect(conventionalScopes('Harden deploy')).toEqual([]);
  });

  test('assigns a scoped pull request to its scope instead of every touched package', async () => {
    const shipped = await findShippedPackages(
      'canyonos-v1.0.0',
      'canyonos-v1.1.0',
      async (ref, path) =>
        ref === 'canyonos-v1.1.0'
          ? path.endsWith('.json')
            ? packageJson('1.0.0')
            : pyproject('1.0.0')
          : null
    );
    const files = ['packages/cli/canyonos/deploy.py', 'packages/core/canyonos_core/cli.py'];
    const names = (title: string) =>
      packagesForPullRequest({ title }, files, shipped).map((entry) => entry.name);

    expect(names('fix(core): fail the deploy on an agent that cannot start')).toEqual(['Core']);
    expect(names('feat(dashboard): add a runs page')).toEqual(['API', 'Web']);
    expect(names('feat(skill): tighten the proxy check')).toEqual(['CLI', 'Core']);
    expect(names('Harden deploy')).toEqual(['CLI', 'Core']);
  });
});

describe('release-notes pipeline', () => {
  test('leaves internal pull requests out of the human notes', async () => {
    const testRun = dependencies({
      listAssociatedPullRequests: async () => [
        pullRequest(),
        pullRequest({
          number: 44,
          title: 'ci(cli): release from a GitHub release CAN-397',
          headRefName: 'felipea/can-397-release',
        }),
      ],
    });

    const result = await runReleaseNotesPipeline(options, testRun.dependencies);

    expect(result.ok).toBe(true);
    expect(testRun.calls.claude.map((call) => call.issues)).toEqual([['CAN-42'], []]);
    expect(result.audit.pullRequests).toEqual([
      expect.objectContaining({ number: 42, source: 'linear' }),
      expect.objectContaining({ number: 44, packages: [], source: 'internal' }),
    ]);
  });

  test('writes one section per shipped package with its release link', async () => {
    const testRun = dependencies({
      listAssociatedPullRequests: async () => [
        pullRequest(),
        pullRequest({
          number: 43,
          title: 'Faster agent startup',
          body: 'Agents boot twice as fast.',
          headRefName: 'feature/startup',
        }),
      ],
      listPullRequestFiles: async (number) =>
        number === 42 ? ['packages/cli/src/canyonos/deploy.py'] : ['packages/core/src/runtime.py'],
    });

    const result = await runReleaseNotesPipeline(options, testRun.dependencies);

    expect(result.ok).toBe(true);
    expect(testRun.calls.claude).toEqual([
      { packageName: 'CLI', issues: ['CAN-42'], fallbackPullRequests: [] },
      {
        packageName: 'Core',
        issues: [],
        fallbackPullRequests: [
          { title: 'Faster agent startup', body: 'Agents boot twice as fast.' },
        ],
      },
    ]);
    expect(testRun.files.get('/output/release-notes.md')).toBe(
      [
        '# Release notes for canyonos-v1.1.0',
        '',
        '## CLI [cli-v0.1.731](https://github.com/CanyonCodeCoreAI/canyonos/releases/tag/cli-v0.1.731)',
        '',
        '### Improved',
        '',
        '- CLI change.',
        '',
        '## Core [core-v0.2.0](https://github.com/CanyonCodeCoreAI/canyonos/releases/tag/core-v0.2.0)',
        '',
        '### Improved',
        '',
        '- Core change.',
        '',
      ].join('\n')
    );
  });

  test('excludes pull requests that touch no shipped package', async () => {
    const testRun = dependencies({
      listAssociatedPullRequests: async () => [
        pullRequest({ title: 'Tweak web copy CAN-99', headRefName: 'feature/web' }),
      ],
      listPullRequestFiles: async () => ['packages/web/src/app.tsx'],
    });

    const result = await runReleaseNotesPipeline(options, testRun.dependencies);

    expect(result.ok).toBe(true);
    expect(testRun.calls.linear).toBe(0);
    expect(result.audit.pullRequests).toEqual([
      expect.objectContaining({ number: 42, packages: [], source: 'excluded' }),
    ]);
  });

  test('uses the given previous tag instead of looking one up', async () => {
    const testRun = dependencies({
      findPreviousRelease: async () => {
        throw new Error('must not be called');
      },
    });

    const result = await runReleaseNotesPipeline(
      { ...options, previousTag: 'canyonos-v1.0.0' },
      testRun.dependencies
    );

    expect(result.ok).toBe(true);
    expect(result.audit.previousTag).toBe('canyonos-v1.0.0');
  });

  test('reads git history from the target ref when the draft has no tag yet', async () => {
    const refs: string[] = [];
    const testRun = dependencies({
      isAncestor: async (_previous, target) => {
        refs.push(target);
        return true;
      },
      readFileAt: async (ref, path) => {
        refs.push(ref);
        return manifests[ref === 'abc123' ? 'canyonos-v1.1.0' : ref]?.[path] ?? null;
      },
      listRangeCommits: async (_previous, target) => {
        refs.push(target);
        return ['commit-a'];
      },
    });

    const result = await runReleaseNotesPipeline(
      { ...options, targetRef: 'abc123' },
      testRun.dependencies
    );

    expect(result.ok).toBe(true);
    expect(refs).not.toContain('canyonos-v1.1.0');
    expect(testRun.files.get('/output/release-notes.md')).toStartWith(
      '# Release notes for canyonos-v1.1.0'
    );
  });

  test('rejects tags that are neither package nor canyonos release tags', async () => {
    const testRun = dependencies();

    const result = await runReleaseNotesPipeline(
      { ...options, targetTag: 'nightly' },
      testRun.dependencies
    );

    expect(result.ok).toBe(false);
    expect(result.audit.failure).toBe(
      'nightly is neither a package release tag nor a release tag like canyonos-v1.0.0.'
    );
  });

  test('fails when no package version changed', async () => {
    const testRun = dependencies({
      readFileAt: async (_ref, path) => manifests['canyonos-v1.0.0']![path] ?? null,
    });

    const result = await runReleaseNotesPipeline(options, testRun.dependencies);

    expect(result.ok).toBe(false);
    expect(testRun.calls.claude).toHaveLength(0);
    expect(testRun.files.get('/output/release-notes-audit.json')).toContain(
      'No package version changed'
    );
  });

  test.each([
    ['missing', []],
    ['canceled', [issue({ state: { name: 'Canceled', type: 'canceled' } })]],
    ['incomplete', [issue({ state: { name: 'In progress', type: 'started' } })]],
  ] as const)('stops when Linear issue is %s', async (caseName, linearIssues) => {
    const testRun = dependencies({ queryLinearIssues: async () => [...linearIssues] });

    const result = await runReleaseNotesPipeline(options, testRun.dependencies);

    expect(result.ok).toBe(false);
    expect(testRun.calls.claude).toHaveLength(0);
    expect(testRun.files.get('/output/release-notes-audit.json')).toContain(caseName);
  });
});

describe('package release changelog', () => {
  const packageOptions = { ...options, targetTag: 'cli-v0.1.731' };

  test('recognises package release tags', () => {
    expect(packageForTag('cli-v0.1.731')?.name).toBe('CLI');
    expect(packageForTag('core-v0.2.0')?.name).toBe('Core');
    expect(packageForTag('canyonos-v1.1.0')).toBeUndefined();
  });

  test('lists only the pull requests that changed the package, without Linear or Claude', async () => {
    const testRun = dependencies({
      findPreviousRelease: async () => ({
        tagName: 'cli-v0.1.730',
        draft: false,
        prerelease: false,
        publishedAt: '2026-09-18T00:00:00Z',
      }),
      listAssociatedPullRequests: async () => [
        pullRequest(),
        pullRequest({ number: 43, title: 'Tune the API pool', author: 'someone' }),
      ],
      listPullRequestFiles: async (number) =>
        number === 42 ? ['packages/cli/canyonos/deploy.py'] : ['packages/api/src/pool.ts'],
    });

    const result = await runReleaseNotesPipeline(packageOptions, testRun.dependencies);

    expect(result.ok).toBe(true);
    expect(testRun.calls.linear).toBe(0);
    expect(testRun.calls.claude).toHaveLength(0);
    expect(testRun.files.get('/output/release-notes.md')).toBe(
      [
        "## What's Changed",
        '',
        '* Improve deploy output CAN-42 by @felipea in https://github.com/CanyonCodeCoreAI/canyonos/pull/42',
        '',
        '**Full Changelog**: https://github.com/CanyonCodeCoreAI/canyonos/compare/cli-v0.1.730...cli-v0.1.731',
        '',
      ].join('\n')
    );
    expect(result.audit.packages).toEqual([
      { name: 'CLI', tag: 'cli-v0.1.731', previousVersion: '0.1.730', pullRequests: [42] },
    ]);
  });

  test('says so when no pull request changed the package', () => {
    expect(
      composePackageChangelog('web-v0.2.0', 'web-v0.1.0', 'CanyonCodeCoreAI/canyonos', [])
    ).toContain('No pull requests changed this package.');
  });
});
