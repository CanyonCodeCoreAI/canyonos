import { describe, expect, test } from 'bun:test';

import {
  deduplicateIssues,
  deduplicatePullRequests,
  extractCanIdentifiers,
  pickPreviousRelease,
  queryLinearIssues,
  releaseLine,
  runReleaseNotesPipeline,
} from './release-notes';
import type { LinearIssue, PipelineDependencies, PullRequest, Release } from './release-notes';

const pullRequest = (overrides: Partial<PullRequest> = {}): PullRequest => ({
  number: 42,
  url: 'https://github.com/CanyonCodeCoreAI/canyonos/pull/42',
  title: 'Improve dashboard CAN-42',
  body: null,
  headRefName: 'felipea/can-42-dashboard',
  mergedAt: '2026-09-10T00:00:00Z',
  ...overrides,
});

const issue = (overrides: Partial<LinearIssue> = {}): LinearIssue => ({
  identifier: 'CAN-42',
  title: 'Improve dashboard',
  description: 'A user-visible dashboard update.',
  state: { name: 'Done', type: 'completed' },
  labels: ['web'],
  project: { name: 'Platform' },
  cycle: { name: 'September', number: 12 },
  ...overrides,
});

function dependencies(overrides: Partial<PipelineDependencies> = {}) {
  const files = new Map<string, string>();
  const calls: {
    linear: number;
    claude: number;
    fallbackPullRequests: Array<Pick<PullRequest, 'title' | 'body'>>;
  } = { linear: 0, claude: 0, fallbackPullRequests: [] };
  const base: PipelineDependencies = {
    findPreviousRelease: async () => ({
      tagName: 'cli-v0.3.4',
      draft: false,
      prerelease: false,
      publishedAt: '2026-09-09T00:00:00Z',
    }),
    isAncestor: async () => true,
    listRangeCommits: async () => ['commit-a'],
    listAssociatedPullRequests: async () => [pullRequest()],
    queryLinearIssues: async () => {
      calls.linear += 1;
      return [issue()];
    },
    generateClaudeNotes: async (_issues, fallbackPullRequests) => {
      calls.claude += 1;
      calls.fallbackPullRequests = fallbackPullRequests ?? [];
      return '## New\n\n## Improved\n\n- The dashboard is easier to use.\n\n## Fixed\n';
    },
    writeFile: async (path, content) => {
      files.set(path, content);
    },
  };
  return { dependencies: { ...base, ...overrides }, files, calls };
}

describe('release-note validation', () => {
  test('extracts identifiers from the title and head branch only', () => {
    const withBody = {
      ...pullRequest({ title: 'Improve CAN-12', headRefName: 'feature/cAn-34' }),
      body: 'CAN-56 must be ignored',
    } as PullRequest;

    expect(extractCanIdentifiers(withBody)).toEqual(['CAN-12', 'CAN-34']);
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
      const response = request.query.includes('issue(id: $identifier)')
        ? {
            data: {
              issue: identifier
                ? { ...issue(), identifier, labels: { nodes: [{ name: 'web' }] } }
                : null,
            },
          }
        : { data: { issues: { nodes: [] } } };
      return new Response(JSON.stringify(response));
    };

    const issues = await queryLinearIssues(['CAN-42', 'CAN-43'], {
      apiKey: 'test-key',
      fetch: fetch as typeof globalThis.fetch,
    });

    expect(requests).toHaveLength(2);
    expect(requests.map((request) => request.variables.identifier)).toEqual(['CAN-42', 'CAN-43']);
    expect(requests.every((request) => request.query.includes('issue(id: $identifier)'))).toBe(
      true
    );
    expect(issues.map((entry) => entry.identifier)).toEqual(['CAN-42', 'CAN-43']);
  });

  test('uses a no-CAN PR title and body as Claude fallback context', async () => {
    const fallbackPullRequest = pullRequest({
      title: 'Improve dashboard',
      body: 'Make the dashboard easier to use.',
      headRefName: 'feature/dashboard',
    });
    const testRun = dependencies({
      listAssociatedPullRequests: async () => [fallbackPullRequest],
    });

    const result = await runReleaseNotesPipeline(
      { targetTag: 'cli-v0.3.5', outputDirectory: '/output' },
      testRun.dependencies
    );

    expect(result.ok).toBe(true);
    expect(testRun.calls.linear).toBe(0);
    expect(testRun.calls.claude).toBe(1);
    expect(testRun.calls.fallbackPullRequests).toEqual([
      { title: fallbackPullRequest.title, body: fallbackPullRequest.body },
    ]);
    expect(JSON.parse(testRun.files.get('/output/release-notes-audit.json')!).pullRequests).toEqual(
      [expect.objectContaining({ number: fallbackPullRequest.number, source: 'fallback' })]
    );
    expect(testRun.files.get('/output/release-notes-audit.json')).not.toContain(
      fallbackPullRequest.body
    );
  });

  test('writes Claude Markdown after complete Linear validation', async () => {
    const markdown = '## New\n\n- A user-facing feature.\n\n## Improved\n\n## Fixed\n';
    const titledMarkdown = `# Release notes for cli-v0.3.5\n\n${markdown}`;
    const testRun = dependencies({
      generateClaudeNotes: async () => markdown,
    });

    const result = await runReleaseNotesPipeline(
      { targetTag: 'cli-v0.3.5', outputDirectory: '/output' },
      testRun.dependencies
    );

    expect(result.ok).toBe(true);
    expect(result).toMatchObject({ markdown: titledMarkdown });
    expect(testRun.files.get('/output/release-notes.md')).toBe(titledMarkdown);
    expect(testRun.files.get('/output/release-notes-audit.json')).toContain(
      '"status": "generated"'
    );
  });

  test.each([
    ['missing', []],
    ['canceled', [issue({ state: { name: 'Canceled', type: 'canceled' } })]],
    ['incomplete', [issue({ state: { name: 'In progress', type: 'started' } })]],
  ] as const)('stops when Linear issue is %s', async (_caseName, linearIssues) => {
    const testRun = dependencies({ queryLinearIssues: async () => [...linearIssues] });

    const result = await runReleaseNotesPipeline(
      { targetTag: 'cli-v0.3.5', outputDirectory: '/output' },
      testRun.dependencies
    );

    expect(result.ok).toBe(false);
    expect(testRun.calls.claude).toBe(0);
    expect(testRun.files.get('/output/release-notes-audit.json')).toContain(_caseName);
  });

  test('reads the release line from the tag prefix', () => {
    expect(releaseLine('cli-v0.1.730')).toBe('cli-');
    expect(releaseLine('api-v0.1.0')).toBe('api-');
    expect(releaseLine('v1.2.3')).toBe('');
  });

  test('picks the latest earlier release on the same release line', () => {
    const release = (
      tagName: string,
      publishedAt: string | null,
      flags: Partial<Release> = {}
    ) => ({
      tagName,
      draft: false,
      prerelease: false,
      publishedAt,
      ...flags,
    });
    const target = release('cli-v0.1.3', '2026-09-20T00:00:00Z');

    const previous = pickPreviousRelease(target, [
      release('cli-v0.1.1', '2026-09-10T00:00:00Z'),
      release('cli-v0.1.2', '2026-09-15T00:00:00Z'),
      release('api-v0.2.0', '2026-09-18T00:00:00Z'),
      release('cli-v0.1.4-rc', '2026-09-19T00:00:00Z', { prerelease: true }),
      target,
      release('cli-v0.1.4', '2026-09-21T00:00:00Z'),
    ]);

    expect(previous.tagName).toBe('cli-v0.1.2');
  });

  test('fails when the release line has no earlier release', () => {
    const target = {
      tagName: 'web-v0.1.0',
      draft: false,
      prerelease: false,
      publishedAt: '2026-09-20T00:00:00Z',
    };

    expect(() => pickPreviousRelease(target, [{ ...target, tagName: 'cli-v0.1.0' }])).toThrow(
      'No previous published release exists before web-v0.1.0.'
    );
  });
});
