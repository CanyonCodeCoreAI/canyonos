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
  author: string | null;
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
export type ReleasablePackage = {
  name: string;
  tagPrefix: string;
  manifest: string;
  paths: string[];
};
export type ShippedPackage = ReleasablePackage & {
  version: string;
  previousVersion: string | null;
};
export type FallbackPullRequest = Pick<PullRequest, 'title' | 'body'>;
export type ReleaseNotesAudit = {
  targetTag: string;
  previousTag?: string;
  status: 'failed' | 'generated';
  failure?: string;
  packages: Array<{
    name: string;
    tag: string;
    previousVersion: string | null;
    pullRequests: number[];
  }>;
  pullRequests: Array<
    Omit<PullRequest, 'body'> & {
      identifiers: string[];
      packages: string[];
      source: 'linear' | 'fallback' | 'changelog' | 'excluded';
    }
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
  readFileAt: (ref: string, path: string) => Promise<string | null>;
  listRangeCommits: (previousTag: string, targetTag: string) => Promise<string[]>;
  listAssociatedPullRequests: (commit: string) => Promise<PullRequest[]>;
  listPullRequestFiles: (pullRequestNumber: number) => Promise<string[]>;
  queryLinearIssues: (identifiers: string[]) => Promise<LinearIssue[]>;
  generateClaudeNotes: (
    packageName: string,
    issues: LinearIssue[],
    fallbackPullRequests: FallbackPullRequest[]
  ) => Promise<string>;
  writeFile: (path: string, content: string) => Promise<void>;
};

export type PipelineOptions = {
  targetTag: string;
  previousTag?: string;
  repository: string;
  outputDirectory: string;
};

export type PipelineResult =
  | { ok: true; audit: ReleaseNotesAudit; markdown: string }
  | { ok: false; audit: ReleaseNotesAudit };

export const releasablePackages: ReleasablePackage[] = [
  {
    name: 'CLI',
    tagPrefix: 'cli-v',
    manifest: 'packages/cli/pyproject.toml',
    paths: ['packages/cli/'],
  },
  {
    name: 'Core',
    tagPrefix: 'core-v',
    manifest: 'packages/core/pyproject.toml',
    paths: ['packages/core/'],
  },
  {
    name: 'API',
    tagPrefix: 'api-v',
    manifest: 'packages/api/package.json',
    paths: ['packages/api/'],
  },
  {
    name: 'Web',
    tagPrefix: 'web-v',
    manifest: 'packages/web/package.json',
    paths: ['packages/web/', 'packages/ui/'],
  },
];

export const umbrellaTagPattern = /^v\d{4}\.\d{2}\.\d{2}(\.\d+)?$/;

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

export function readManifestVersion(manifest: string, content: string): string {
  const version = manifest.endsWith('.json')
    ? (JSON.parse(content) as { version?: string }).version
    : content.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
  if (!version) throw new Error(`${manifest} has no version.`);
  return version;
}

export async function findShippedPackages(
  previousTag: string,
  targetTag: string,
  readFileAt: PipelineDependencies['readFileAt']
): Promise<ShippedPackage[]> {
  const shipped = await Promise.all(
    releasablePackages.map(async (releasable) => {
      const [current, previous] = await Promise.all([
        readFileAt(targetTag, releasable.manifest),
        readFileAt(previousTag, releasable.manifest),
      ]);
      if (current === null) return null;
      const version = readManifestVersion(releasable.manifest, current);
      const previousVersion =
        previous === null ? null : readManifestVersion(releasable.manifest, previous);
      return version === previousVersion ? null : { ...releasable, version, previousVersion };
    })
  );
  return shipped.filter((entry): entry is ShippedPackage => entry !== null);
}

export function packagesTouchedBy<T extends ReleasablePackage>(
  files: string[],
  packages: T[]
): T[] {
  return packages.filter((releasable) =>
    files.some((file) => releasable.paths.some((path) => file.startsWith(path)))
  );
}

export function packageForTag(tagName: string): ReleasablePackage | undefined {
  return releasablePackages.find(
    (releasable) =>
      tagName.startsWith(releasable.tagPrefix) &&
      /^\d/.test(tagName.slice(releasable.tagPrefix.length))
  );
}

export function composePackageChangelog(
  targetTag: string,
  previousTag: string,
  repository: string,
  pullRequests: PullRequest[]
): string {
  const entries =
    pullRequests.length === 0
      ? ['No pull requests changed this package.']
      : pullRequests.map(
          (pullRequest) =>
            `* ${pullRequest.title}${pullRequest.author ? ` by @${pullRequest.author}` : ''} in ${pullRequest.url}`
        );
  return `## What's Changed\n\n${entries.join('\n')}\n\n**Full Changelog**: https://github.com/${repository}/compare/${previousTag}...${targetTag}\n`;
}

export function composeReleaseNotes(
  targetTag: string,
  repository: string,
  sections: Array<{ shipped: ShippedPackage; markdown: string }>
): string {
  const body = sections
    .map(({ shipped, markdown }) => {
      const tag = `${shipped.tagPrefix}${shipped.version}`;
      const link = `https://github.com/${repository}/releases/tag/${tag}`;
      return `## ${shipped.name} [${tag}](${link})\n\n${markdown.trim()}\n`;
    })
    .join('\n');
  return `# Release notes for ${targetTag}\n\n${body}`;
}

export async function runReleaseNotesPipeline(
  options: PipelineOptions,
  dependencies: PipelineDependencies
): Promise<PipelineResult> {
  const audit: ReleaseNotesAudit = {
    targetTag: options.targetTag,
    status: 'failed',
    packages: [],
    pullRequests: [],
    issues: [],
  };
  const writeAudit = () =>
    dependencies.writeFile(
      join(options.outputDirectory, 'release-notes-audit.json'),
      `${JSON.stringify(audit, null, 2)}\n`
    );

  try {
    const releasable = packageForTag(options.targetTag);
    if (!releasable && !umbrellaTagPattern.test(options.targetTag)) {
      throw new Error(
        `${options.targetTag} is neither a package release tag nor a release tag like v2026.09.25.`
      );
    }
    const previousTag =
      options.previousTag ?? (await dependencies.findPreviousRelease(options.targetTag)).tagName;
    audit.previousTag = previousTag;
    if (!(await dependencies.isAncestor(previousTag, options.targetTag))) {
      throw new Error(`${previousTag} is not an ancestor of ${options.targetTag}.`);
    }

    const collected = await collectPullRequests(previousTag, options.targetTag, dependencies);
    const markdown = releasable
      ? packageChangelog(releasable, previousTag, collected)
      : await datedReleaseNotes(previousTag, collected);
    audit.status = 'generated';
    await writeAudit();
    await dependencies.writeFile(join(options.outputDirectory, 'release-notes.md'), markdown);
    return { ok: true, audit, markdown };
  } catch (error) {
    audit.failure = error instanceof Error ? error.message : String(error);
    await writeAudit();
    return { ok: false, audit };
  }

  function packageChangelog(
    releasable: ReleasablePackage,
    previousTag: string,
    collected: CollectedPullRequest[]
  ): string {
    const references = collected.map(({ pullRequest, files }) => ({
      pullRequest,
      touched: packagesTouchedBy(files, [releasable]).length > 0,
    }));
    const included = references
      .filter(({ touched }) => touched)
      .map(({ pullRequest }) => pullRequest);
    audit.pullRequests = references.map(({ pullRequest, touched }) => ({
      ...auditPullRequest(pullRequest),
      packages: touched ? [releasable.name] : [],
      source: touched ? 'changelog' : 'excluded',
    }));
    audit.packages = [
      {
        name: releasable.name,
        tag: options.targetTag,
        previousVersion: previousTag.startsWith(releasable.tagPrefix)
          ? previousTag.slice(releasable.tagPrefix.length)
          : null,
        pullRequests: included.map((pullRequest) => pullRequest.number),
      },
    ];
    return composePackageChangelog(options.targetTag, previousTag, options.repository, included);
  }

  async function datedReleaseNotes(
    previousTag: string,
    collected: CollectedPullRequest[]
  ): Promise<string> {
    const shippedPackages = await findShippedPackages(
      previousTag,
      options.targetTag,
      dependencies.readFileAt
    );
    if (shippedPackages.length === 0) {
      throw new Error(
        `No package version changed between ${previousTag} and ${options.targetTag}.`
      );
    }

    const references = collected.map(({ pullRequest, files }) => ({
      pullRequest,
      identifiers: extractCanIdentifiers(pullRequest),
      packages: packagesTouchedBy(files, shippedPackages),
    }));
    audit.pullRequests = references.map(({ pullRequest, identifiers, packages }) => ({
      ...auditPullRequest(pullRequest),
      identifiers,
      packages: packages.map((shipped) => shipped.name),
      source: packages.length === 0 ? 'excluded' : identifiers.length === 0 ? 'fallback' : 'linear',
    }));
    audit.packages = shippedPackages.map((shipped) => ({
      name: shipped.name,
      tag: `${shipped.tagPrefix}${shipped.version}`,
      previousVersion: shipped.previousVersion,
      pullRequests: references
        .filter(({ packages }) => packages.includes(shipped))
        .map(({ pullRequest }) => pullRequest.number),
    }));

    const included = references.filter(({ packages }) => packages.length > 0);
    const identifiers = [...new Set(included.flatMap(({ identifiers }) => identifiers))].sort();
    const linearIssues =
      identifiers.length === 0
        ? []
        : deduplicateIssues(await dependencies.queryLinearIssues(identifiers));
    audit.issues = validateLinearIssues(identifiers, linearIssues);
    const failedIssues = audit.issues.filter((issue) => issue.status !== 'validated');
    if (failedIssues.length > 0) {
      throw new Error(
        `Linear issue validation failed: ${failedIssues.map((issue) => issue.identifier).join(', ')}.`
      );
    }

    const sections = await Promise.all(
      shippedPackages.map(async (shipped) => {
        const packageReferences = included.filter(({ packages }) => packages.includes(shipped));
        const packageIdentifiers = new Set(
          packageReferences.flatMap(({ identifiers }) => identifiers)
        );
        const markdown = await dependencies.generateClaudeNotes(
          shipped.name,
          linearIssues.filter((issue) => packageIdentifiers.has(issue.identifier.toUpperCase())),
          packageReferences
            .filter(({ identifiers }) => identifiers.length === 0)
            .map(({ pullRequest }) => ({ title: pullRequest.title, body: pullRequest.body }))
        );
        return { shipped, markdown };
      })
    );
    return composeReleaseNotes(options.targetTag, options.repository, sections);
  }
}

type CollectedPullRequest = { pullRequest: PullRequest; files: string[] };

async function collectPullRequests(
  previousTag: string,
  targetTag: string,
  dependencies: PipelineDependencies
): Promise<CollectedPullRequest[]> {
  const commits = await dependencies.listRangeCommits(previousTag, targetTag);
  const pullRequests = deduplicatePullRequests(
    (
      await Promise.all(commits.map((commit) => dependencies.listAssociatedPullRequests(commit)))
    ).flat()
  );
  return Promise.all(
    pullRequests.map(async (pullRequest) => ({
      pullRequest,
      files: await dependencies.listPullRequestFiles(pullRequest.number),
    }))
  );
}

function auditPullRequest(pullRequest: PullRequest) {
  return {
    number: pullRequest.number,
    url: pullRequest.url,
    title: pullRequest.title,
    headRefName: pullRequest.headRefName,
    mergedAt: pullRequest.mergedAt,
    author: pullRequest.author,
    identifiers: extractCanIdentifiers(pullRequest),
  };
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
  user: { login: string } | null;
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
    author: pullRequest.user?.login ?? null,
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
  packageName: string,
  issues: LinearIssue[],
  fallbackPullRequests: FallbackPullRequest[]
): Promise<string> {
  let markdown: string | null = null;
  const prompt = `Write concise user-facing Markdown release notes for the ${packageName} package from validated Linear issues and fallback pull request context. Use only these headings, in this order, and leave out a heading that has no entries: ### New, ### Improved, ### Fixed. Do not add other headings, an introduction, pull requests, or implementation details. Omit internal work. Do not invent facts. If nothing is user-facing, reply with exactly: No user-facing changes.\n\n${JSON.stringify({ issues, fallbackPullRequests })}`;
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

async function createDependencies(repository: string): Promise<PipelineDependencies> {
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
    readFileAt: async (ref, path) => {
      const process = Bun.spawn(['git', 'show', `${ref}:${path}`], {
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [stdout, exitCode] = await Promise.all([
        new Response(process.stdout).text(),
        process.exited,
      ]);
      return exitCode === 0 ? stdout : null;
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
    listPullRequestFiles: async (pullRequestNumber) =>
      (
        await command('gh', [
          'api',
          '--paginate',
          `repos/${repository}/pulls/${pullRequestNumber}/files?per_page=100`,
          '--jq',
          '.[].filename',
        ])
      )
        .trim()
        .split('\n')
        .filter(Boolean),
    queryLinearIssues,
    generateClaudeNotes,
    writeFile: async (path, content) => {
      await Bun.write(path, content);
    },
  };
}

if (import.meta.main) {
  const [targetTag, previousTag] = process.argv.slice(2);
  if (!targetTag) {
    throw new Error('Usage: bun run scripts/release-notes.ts <release-tag> [previous-tag]');
  }
  const repository = (
    await command('gh', ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'])
  ).trim();
  const result = await runReleaseNotesPipeline(
    {
      targetTag,
      previousTag: previousTag || undefined,
      repository,
      outputDirectory: process.env.RELEASE_NOTES_OUTPUT_DIR ?? process.cwd(),
    },
    await createDependencies(repository)
  );
  if (!result.ok) {
    console.error(`[release-notes] ${result.audit.failure}`);
    process.exitCode = 1;
  }
}
