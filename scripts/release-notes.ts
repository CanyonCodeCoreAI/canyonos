import { join } from 'node:path';

import { query } from '@anthropic-ai/claude-agent-sdk';

export type Release = {
  tagName: string;
  draft: boolean;
  prerelease: boolean;
  publishedAt: string | null;
};
export type PullRequest = {
  number: number;
  url: string;
  title: string;
  body: string | null;
  headRefName: string;
  mergedAt: string | null;
};
export type LinearIssue = {
  identifier: string;
  title: string;
  description: string | null;
  state: { name: string; type: string };
  labels: string[];
  project: { name: string } | null;
  cycle: { name: string; number: number | null } | null;
};
export type ReleaseNotesAudit = {
  targetTag: string;
  previousTag?: string;
  status: 'failed' | 'generated';
  failure?: string;
  pullRequests: Array<
    Omit<PullRequest, 'body'> & { identifiers: string[]; source: 'linear' | 'fallback' }
  >;
  issues: Array<{
    identifier: string;
    status: 'validated' | 'missing' | 'canceled' | 'incomplete';
    state?: string;
  }>;
};

export type PipelineDependencies = {
  findPreviousRelease: (targetTag: string) => Promise<Release>;
  isAncestor: (previousTag: string, targetTag: string) => Promise<boolean>;
  listRangeCommits: (previousTag: string, targetTag: string) => Promise<string[]>;
  listAssociatedPullRequests: (commit: string) => Promise<PullRequest[]>;
  queryLinearIssues: (identifiers: string[]) => Promise<LinearIssue[]>;
  generateClaudeNotes: (
    issues: LinearIssue[],
    fallbackPullRequests: Array<Pick<PullRequest, 'title' | 'body'>>
  ) => Promise<string>;
  writeFile: (path: string, content: string) => Promise<void>;
};

export type PipelineOptions = {
  targetTag: string;
  outputDirectory: string;
};

export type PipelineResult =
  | { ok: true; audit: ReleaseNotesAudit; markdown: string }
  | { ok: false; audit: ReleaseNotesAudit };

const identifierPattern = /\bCAN-(\d+)\b/gi;

export function extractCanIdentifiers(pullRequest: PullRequest): string[] {
  const identifiers = new Set<string>();
  for (const value of [pullRequest.title, pullRequest.headRefName]) {
    for (const match of value.matchAll(identifierPattern)) {
      identifiers.add(`CAN-${match[1]}`);
    }
  }
  return [...identifiers].sort();
}

export function deduplicatePullRequests(pullRequests: PullRequest[]): PullRequest[] {
  const byNumber = new Map<number, PullRequest>();
  for (const pullRequest of pullRequests) {
    if (pullRequest.mergedAt) byNumber.set(pullRequest.number, pullRequest);
  }
  return [...byNumber.values()].sort((left, right) => left.number - right.number);
}

export function deduplicateIssues(issues: LinearIssue[]): LinearIssue[] {
  return [...new Map(issues.map((issue) => [issue.identifier.toUpperCase(), issue])).values()].sort(
    (left, right) => left.identifier.localeCompare(right.identifier)
  );
}

export function validateLinearIssues(
  identifiers: string[],
  issues: LinearIssue[]
): ReleaseNotesAudit['issues'] {
  const issuesByIdentifier = new Map(
    issues.map((issue) => [issue.identifier.toUpperCase(), issue])
  );
  return identifiers.map((identifier) => {
    const issue = issuesByIdentifier.get(identifier);
    if (!issue) return { identifier, status: 'missing' };
    if (issue.state.type === 'canceled') {
      return { identifier, status: 'canceled', state: issue.state.name };
    }
    if (issue.state.type !== 'completed') {
      return { identifier, status: 'incomplete', state: issue.state.name };
    }
    return { identifier, status: 'validated', state: issue.state.name };
  });
}

export function releaseLine(tagName: string): string {
  return tagName.replace(/v?\d[\w.+-]*$/, '');
}

export function pickPreviousRelease(target: Release, releases: Release[]): Release {
  if (target.draft || target.prerelease || !target.publishedAt) {
    throw new Error(`${target.tagName} must be a published, non-prerelease release.`);
  }
  const line = releaseLine(target.tagName);
  const previous = releases
    .filter((release) => !release.draft && !release.prerelease && release.publishedAt)
    .filter((release) => release.tagName !== target.tagName)
    .filter((release) => releaseLine(release.tagName) === line)
    .filter((release) => release.publishedAt! < target.publishedAt!)
    .sort((left, right) => right.publishedAt!.localeCompare(left.publishedAt!))[0];
  if (!previous) throw new Error(`No previous published release exists before ${target.tagName}.`);
  return previous;
}

export async function runReleaseNotesPipeline(
  options: PipelineOptions,
  dependencies: PipelineDependencies
): Promise<PipelineResult> {
  const pullRequests: ReleaseNotesAudit['pullRequests'] = [];
  const audit = (status: ReleaseNotesAudit['status'], failure?: string): ReleaseNotesAudit => ({
    targetTag: options.targetTag,
    status,
    ...(failure ? { failure } : {}),
    pullRequests,
    issues: [],
  });
  const fail = async (failedAudit: ReleaseNotesAudit): Promise<PipelineResult> => {
    await dependencies.writeFile(
      join(options.outputDirectory, 'release-notes-audit.json'),
      `${JSON.stringify(failedAudit, null, 2)}\n`
    );
    return { ok: false, audit: failedAudit };
  };

  let previousRelease: Release;
  try {
    previousRelease = await dependencies.findPreviousRelease(options.targetTag);
  } catch (error) {
    return fail(audit('failed', error instanceof Error ? error.message : String(error)));
  }
  const ancestorAudit = audit('failed');
  ancestorAudit.previousTag = previousRelease.tagName;
  if (!(await dependencies.isAncestor(previousRelease.tagName, options.targetTag))) {
    ancestorAudit.failure = `${previousRelease.tagName} is not an ancestor of ${options.targetTag}.`;
    return fail(ancestorAudit);
  }

  let associatedPullRequests: PullRequest[];
  try {
    const commits = await dependencies.listRangeCommits(previousRelease.tagName, options.targetTag);
    associatedPullRequests = deduplicatePullRequests(
      (
        await Promise.all(commits.map((commit) => dependencies.listAssociatedPullRequests(commit)))
      ).flat()
    );
  } catch (error) {
    const failedAudit = audit('failed', error instanceof Error ? error.message : String(error));
    failedAudit.previousTag = previousRelease.tagName;
    return fail(failedAudit);
  }
  const pullRequestReferences = associatedPullRequests.map((pullRequest) => ({
    pullRequest,
    identifiers: extractCanIdentifiers(pullRequest),
  }));
  pullRequests.push(
    ...pullRequestReferences.map(({ pullRequest, identifiers }) => ({
      number: pullRequest.number,
      url: pullRequest.url,
      title: pullRequest.title,
      headRefName: pullRequest.headRefName,
      mergedAt: pullRequest.mergedAt,
      identifiers,
      source: identifiers.length === 0 ? ('fallback' as const) : ('linear' as const),
    }))
  );

  const identifiers = [
    ...new Set(pullRequests.flatMap((pullRequest) => pullRequest.identifiers)),
  ].sort();
  const fallbackPullRequests = pullRequestReferences
    .filter(({ identifiers }) => identifiers.length === 0)
    .map(({ pullRequest }) => ({ title: pullRequest.title, body: pullRequest.body }));
  let linearIssues: LinearIssue[];
  try {
    linearIssues =
      identifiers.length === 0
        ? []
        : deduplicateIssues(await dependencies.queryLinearIssues(identifiers));
  } catch (error) {
    const failedAudit = audit('failed', error instanceof Error ? error.message : String(error));
    failedAudit.previousTag = previousRelease.tagName;
    return fail(failedAudit);
  }
  const issueValidation = validateLinearIssues(identifiers, linearIssues);
  const failedIssues = issueValidation.filter((issue) => issue.status !== 'validated');
  if (failedIssues.length > 0) {
    const failedAudit = audit(
      'failed',
      `Linear issue validation failed: ${failedIssues.map((issue) => issue.identifier).join(', ')}.`
    );
    failedAudit.previousTag = previousRelease.tagName;
    failedAudit.issues = issueValidation;
    return fail(failedAudit);
  }

  let markdown: string;
  try {
    markdown = await dependencies.generateClaudeNotes(linearIssues, fallbackPullRequests);
  } catch (error) {
    const failedAudit = audit('failed', error instanceof Error ? error.message : String(error));
    failedAudit.previousTag = previousRelease.tagName;
    failedAudit.issues = issueValidation;
    return fail(failedAudit);
  }
  const titledMarkdown = `# Release notes for ${options.targetTag}\n\n${markdown}`;
  const completedAudit = audit('generated');
  completedAudit.previousTag = previousRelease.tagName;
  completedAudit.issues = issueValidation;
  await dependencies.writeFile(
    join(options.outputDirectory, 'release-notes-audit.json'),
    `${JSON.stringify(completedAudit, null, 2)}\n`
  );
  await dependencies.writeFile(join(options.outputDirectory, 'release-notes.md'), titledMarkdown);
  return { ok: true, audit: completedAudit, markdown: titledMarkdown };
}

type GitHubRelease = {
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  published_at: string | null;
};
type GitHubPullRequest = {
  number: number;
  html_url: string;
  title: string;
  body: string | null;
  merged_at: string | null;
  head: { ref: string };
};

async function command(command: string, args: string[]): Promise<string> {
  const process = Bun.spawn([command, ...args], { stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (exitCode !== 0) throw new Error(`${command} ${args.join(' ')} failed: ${stderr.trim()}`);
  return stdout;
}

function parseJsonLines<T>(value: string): T[] {
  return value
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

function releaseFromGitHub(release: GitHubRelease): Release {
  return {
    tagName: release.tag_name,
    draft: release.draft,
    prerelease: release.prerelease,
    publishedAt: release.published_at,
  };
}

function pullRequestFromGitHub(pullRequest: GitHubPullRequest): PullRequest {
  return {
    number: pullRequest.number,
    url: pullRequest.html_url,
    title: pullRequest.title,
    body: pullRequest.body,
    headRefName: pullRequest.head.ref,
    mergedAt: pullRequest.merged_at,
  };
}

export async function queryLinearIssues(
  identifiers: string[],
  options: { apiKey?: string; fetch?: typeof fetch } = {}
): Promise<LinearIssue[]> {
  const key = options.apiKey ?? process.env.LINEAR_API_KEY;
  if (!key) throw new Error('LINEAR_API_KEY is required.');
  const fetchLinear = options.fetch ?? fetch;
  const issues = await Promise.all(
    identifiers.map(async (identifier) => {
      const response = await fetchLinear('https://api.linear.app/graphql', {
        method: 'POST',
        headers: { Authorization: key, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: `query ReleaseNotesIssue($identifier: String!) {
            issue(id: $identifier) {
              identifier title description
              state { name type }
              labels { nodes { name } }
              project { name }
              cycle { name number }
            }
          }`,
          variables: { identifier },
        }),
      });
      const body = (await response.json()) as {
        data?: {
          issue?: Omit<LinearIssue, 'labels'> & { labels: { nodes: Array<{ name: string }> } };
        };
        errors?: Array<{ message: string }>;
      };
      if (!response.ok || body.errors?.length) {
        throw new Error(
          `Linear query failed: ${body.errors?.map((error) => error.message).join('; ') ?? response.statusText}`
        );
      }
      const issue = body.data?.issue;
      return issue ? { ...issue, labels: issue.labels.nodes.map((label) => label.name) } : null;
    })
  );
  return issues.filter((issue): issue is LinearIssue => issue !== null);
}

async function generateClaudeNotes(
  issues: LinearIssue[],
  fallbackPullRequests: Array<Pick<PullRequest, 'title' | 'body'>>
): Promise<string> {
  let markdown: string | null = null;
  const prompt = `Write concise user-facing Markdown release notes from validated Linear issues and fallback pull request context. Use exactly these headings, in this order: ## New, ## Improved, ## Fixed. Do not add other headings, an introduction, pull requests, or implementation details. Omit internal work. Do not invent facts.\n\n${JSON.stringify({ issues, fallbackPullRequests })}`;
  for await (const message of query({
    prompt,
    options: {
      tools: [],
      allowedTools: [],
      permissionMode: 'dontAsk',
      maxTurns: 1,
      maxBudgetUsd: 0.5,
      persistSession: false,
      model: 'claude-sonnet-5',
      effort: 'low',
    },
  })) {
    if (message.type === 'result') {
      if (message.subtype !== 'success') {
        throw new Error(`Claude stopped with ${message.subtype}.`);
      }
      markdown = message.result;
    }
  }
  if (markdown === null) throw new Error('Claude did not return release notes.');
  return markdown;
}

async function createDependencies(): Promise<PipelineDependencies> {
  const repository = (
    await command('gh', ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'])
  ).trim();
  const releases = async (): Promise<Release[]> =>
    parseJsonLines<GitHubRelease>(
      await command('gh', [
        'api',
        '--paginate',
        `repos/${repository}/releases?per_page=100`,
        '--jq',
        '.[]',
      ])
    ).map(releaseFromGitHub);
  return {
    findPreviousRelease: async (targetTag) => {
      const target = releaseFromGitHub(
        JSON.parse(
          await command('gh', [
            'api',
            `repos/${repository}/releases/tags/${encodeURIComponent(targetTag)}`,
          ])
        ) as GitHubRelease
      );
      return pickPreviousRelease(target, await releases());
    },
    isAncestor: async (previousTag, targetTag) => {
      const process = Bun.spawn(['git', 'merge-base', '--is-ancestor', previousTag, targetTag]);
      return (await process.exited) === 0;
    },
    listRangeCommits: async (previousTag, targetTag) =>
      (await command('git', ['rev-list', `${previousTag}..${targetTag}`]))
        .trim()
        .split('\n')
        .filter(Boolean),
    listAssociatedPullRequests: async (commit) => {
      const response = await command('gh', [
        'api',
        `repos/${repository}/commits/${commit}/pulls`,
        '-H',
        'Accept: application/vnd.github+json',
      ]);
      return (JSON.parse(response) as GitHubPullRequest[]).map(pullRequestFromGitHub);
    },
    queryLinearIssues,
    generateClaudeNotes,
    writeFile: async (path, content) => {
      await Bun.write(path, content);
    },
  };
}

if (import.meta.main) {
  const targetTag = process.argv[2];
  if (!targetTag) throw new Error('Usage: bun run scripts/release-notes.ts <target-tag>');
  const result = await runReleaseNotesPipeline(
    { targetTag, outputDirectory: process.env.RELEASE_NOTES_OUTPUT_DIR ?? process.cwd() },
    await createDependencies()
  );
  if (!result.ok) {
    console.error(`[release-notes] ${result.audit.failure}`);
    process.exitCode = 1;
  }
}
