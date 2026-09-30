import { describe, expect, test } from 'bun:test';

import {
  composeReleaseNotes,
  conventionalScopes,
  deduplicateIssues,
  deduplicatePullRequests,
  extractCanIdentifiers,
  isInternalPullRequest,
  packagesForPullRequest,
  packagesTouchedBy,
  pickPreviousRelease,
  queryLinearIssues,
  releasablePackages,
  releaseLine,
  releaseTagPattern,
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
      tagName: 'v0.1.732',
      draft: false,
      prerelease: false,
      publishedAt: '2026-09-18T00:00:00Z',
    }),
    isAncestor: async () => true,
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
  targetTag: 'v0.1.733',
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
    expect(withBody('Write `Fixes CAN-1` to link.\n\n```\nCloses CAN-2\n```\nFixes CAN-3')).toEqual(
      ['CAN-3']
    );
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
    expect(releaseLine('v1.1.0')).toBe('');
  });

  test('picks the latest earlier release on the same release line', () => {
    const target = release('v1.1.0', '2026-09-25T00:00:00Z');

    const previous = pickPreviousRelease(target, [
      release('v0.9.0', '2026-09-11T00:00:00Z'),
      release('v1.0.0', '2026-09-18T00:00:00Z'),
      release('cli-v0.1.731', '2026-09-24T00:00:00Z'),
      release('v1.1.0-rc.1', '2026-09-24T00:00:00Z', { prerelease: true }),
      target,
      release('v1.2.0', '2026-10-02T00:00:00Z'),
    ]);

    expect(previous.tagName).toBe('v1.0.0');
  });

  test('compares a draft with the latest published release on its line', () => {
    const previous = pickPreviousRelease(
      { tagName: 'v1.1.0', publishedAt: null, prerelease: false },
      [
        release('v0.9.0', '2026-09-11T00:00:00Z'),
        release('v1.0.0', '2026-09-18T00:00:00Z'),
        release('cli-v0.1.731', '2026-09-24T00:00:00Z'),
      ]
    );

    expect(previous.tagName).toBe('v1.0.0');
  });

  test('compares a pre-release with the release right before it, of any kind', () => {
    const earlier = [
      release('api-v0.1.0', '2026-09-10T00:00:00Z'),
      release('api-v0.1.1', '2026-09-18T00:00:00Z', { prerelease: true }),
    ];

    expect(
      pickPreviousRelease(
        { tagName: 'api-v0.1.2', publishedAt: '2026-09-25T00:00:00Z', prerelease: true },
        earlier
      ).tagName
    ).toBe('api-v0.1.1');
    expect(
      pickPreviousRelease(
        { tagName: 'api-v0.2.0', publishedAt: '2026-09-25T00:00:00Z', prerelease: false },
        earlier
      ).tagName
    ).toBe('api-v0.1.0');
  });

  test('compares a normal release with a pre-release when no normal release came before', () => {
    expect(
      pickPreviousRelease(
        { tagName: 'web-v0.2.0', publishedAt: '2026-09-25T00:00:00Z', prerelease: false },
        [release('web-v0.1.1', '2026-09-18T00:00:00Z', { prerelease: true })]
      ).tagName
    ).toBe('web-v0.1.1');
  });

  test('fails when the release line has no earlier release', () => {
    const target = release('v1.1.0', '2026-09-25T00:00:00Z');

    expect(() =>
      pickPreviousRelease(target, [release('cli-v0.1.0', '2026-09-01T00:00:00Z')])
    ).toThrow('No previous published release exists before v1.1.0.');
  });

  test('keeps legacy package tags on their own lines', () => {
    const target = release('v0.1.732', '2026-09-30T00:00:00Z');
    const releases = [
      release('cli-v0.1.731', '2026-09-29T00:00:00Z'),
      release('core-v0.3.0', '2026-09-29T00:00:00Z'),
    ];

    expect(() => pickPreviousRelease(target, releases)).toThrow(
      'No previous published release exists before v0.1.732.'
    );
  });
});

describe('release tags', () => {
  test('accepts v tags and nothing else', () => {
    expect(releaseTagPattern.test('v0.1.732')).toBe(true);
    expect(releaseTagPattern.test('cli-v0.1.732')).toBe(false);
    expect(releaseTagPattern.test('canyonos-v1.0.0')).toBe(false);
    expect(releaseTagPattern.test('v0.1.732-rc.1')).toBe(false);
  });

  test('assigns shared UI changes to the web package', () => {
    expect(
      packagesTouchedBy(['packages/ui/src/button.tsx', 'README.md'], releasablePackages).map(
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

  test('assigns a scoped pull request to its scope instead of every touched package', () => {
    const files = ['packages/cli/canyonos/deploy.py', 'packages/core/canyonos_core/cli.py'];
    const names = (title: string) =>
      packagesForPullRequest({ title }, files, releasablePackages).map((entry) => entry.name);

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
    expect(testRun.calls.claude.map((call) => call.issues)).toEqual([['CAN-42']]);
    expect(result.audit.pullRequests).toEqual([
      expect.objectContaining({ number: 42, source: 'linear' }),
      expect.objectContaining({ number: 44, packages: [], source: 'internal' }),
    ]);
  });

  test('writes one section per package that pull requests changed', async () => {
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
        '# Release notes for v0.1.733',
        '',
        '## CLI',
        '',
        '### Improved',
        '',
        '- CLI change.',
        '',
        '## Core',
        '',
        '### Improved',
        '',
        '- Core change.',
        '',
      ].join('\n')
    );
  });

  test('excludes pull requests that touch no package', async () => {
    const testRun = dependencies({
      listAssociatedPullRequests: async () => [
        pullRequest({ title: 'Tweak web copy CAN-99', headRefName: 'feature/web' }),
        pullRequest({
          number: 43,
          title: 'Faster agent startup',
          body: 'Agents boot twice as fast.',
          headRefName: 'feature/startup',
        }),
      ],
      listPullRequestFiles: async (number) =>
        number === 42 ? ['README.md'] : ['packages/cli/src/canyonos/deploy.py'],
    });

    const result = await runReleaseNotesPipeline(options, testRun.dependencies);

    expect(result.ok).toBe(true);
    expect(testRun.calls.linear).toBe(0);
    expect(result.audit.pullRequests).toEqual([
      expect.objectContaining({ number: 42, packages: [], source: 'excluded' }),
      expect.objectContaining({ number: 43, source: 'fallback' }),
    ]);
  });

  test('uses the given previous tag instead of looking one up', async () => {
    const testRun = dependencies({
      findPreviousRelease: async () => {
        throw new Error('must not be called');
      },
    });

    const result = await runReleaseNotesPipeline(
      { ...options, previousTag: 'v0.1.732' },
      testRun.dependencies
    );

    expect(result.ok).toBe(true);
    expect(result.audit.previousTag).toBe('v0.1.732');
  });

  test('reads git history from the target ref when the draft has no tag yet', async () => {
    const refs: string[] = [];
    const testRun = dependencies({
      isAncestor: async (_previous, target) => {
        refs.push(target);
        return true;
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
    expect(refs).not.toContain('v0.1.733');
    expect(testRun.files.get('/output/release-notes.md')).toStartWith(
      '# Release notes for v0.1.733'
    );
  });

  test('rejects tags that are not release tags', async () => {
    const testRun = dependencies();

    const result = await runReleaseNotesPipeline(
      { ...options, targetTag: 'nightly' },
      testRun.dependencies
    );

    expect(result.ok).toBe(false);
    expect(result.audit.failure).toBe('nightly is not a release tag like v0.1.732.');
  });

  test('fails when no pull request changed a package', async () => {
    const testRun = dependencies({ listPullRequestFiles: async () => ['README.md'] });

    const result = await runReleaseNotesPipeline(options, testRun.dependencies);

    expect(result.ok).toBe(false);
    expect(testRun.calls.claude).toHaveLength(0);
    expect(result.audit.failure).toBe(
      'No pull request changed a package between v0.1.732 and v0.1.733.'
    );
  });

  test('leaves out a package with no pull requests', async () => {
    const testRun = dependencies({
      listAssociatedPullRequests: async () => [
        pullRequest(),
        pullRequest({
          number: 44,
          title: 'ci(core): pin the image workflow',
          headRefName: 'felipea/core-ci',
        }),
      ],
      listPullRequestFiles: async (number) =>
        number === 42 ? ['packages/cli/src/canyonos/deploy.py'] : ['packages/core/Dockerfile'],
    });

    const result = await runReleaseNotesPipeline(options, testRun.dependencies);

    expect(result.ok).toBe(true);
    expect(testRun.calls.claude.map((call) => call.packageName)).toEqual(['CLI']);
    expect(testRun.files.get('/output/release-notes.md')).not.toContain('## Core');
    expect(result.audit.packages).toEqual([{ name: 'CLI', pullRequests: [42] }]);
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

describe('composing notes', () => {
  test('writes a heading per section without tag links', () => {
    expect(
      composeReleaseNotes('v0.1.733', [
        { name: 'CLI', markdown: '### New\n\n- Thing.\n' },
        { name: 'Web', markdown: 'No user-facing changes.' },
      ])
    ).toBe(
      '# Release notes for v0.1.733\n\n## CLI\n\n### New\n\n- Thing.\n\n## Web\n\nNo user-facing changes.\n'
    );
  });
});
