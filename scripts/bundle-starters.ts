// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

// Copies the quickstart workflows from examples/ into the CLI package, where
// they ship in the wheel and the binary. `canyonos quickstart` writes the chosen
// one into the user's current directory; examples/ stays the copy people edit.
//
// The bundle is generated: `canyonos#build`, `#build:binary` and
// `#test` depend on the `starters:bundle` task, and `bun run starters:bundle` builds
// it by hand. A build that skips turbo ships no workflows.

import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, join, relative } from 'node:path';

export const repoRoot = join(import.meta.dir, '..');
export const bundleDir = join(repoRoot, 'packages/cli/canyonos/starters');

// Nuitka compiles every `.py` it ships, so a bundled workflow's Python carries
// this suffix and loses it when written out -- the same trick new_app_template
// uses. Users never see it; it exists only inside the package.
export const PYTHON_BUNDLE_SUFFIX = '.tmpl';

// Build output and local state that must not reach the bundle: a workflow
// someone has already deployed or converted in place carries all of it.
const SKIP = new Set([
  '.git',
  // `canyonos convert` writes one holding `.canyon/`; the bundle ships sources only.
  '.gitignore',
  '.venv',
  '.canyon',
  '.claude',
  '.pytest_cache',
  '.ruff_cache',
  '.DS_Store',
  '__pycache__',
  'build',
  'dist',
  'node_modules',
  'results',
  'uv.lock',
]);
const SKIP_SUFFIXES = ['.egg-info', '.pyc'];

function isSkipped(name: string): boolean {
  return SKIP.has(name) || SKIP_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

// Each workflow's `.env`, written into the bundle so the first thing a user sees
// is the key they have to fill in.
//
// A placeholder, not empty: the agents build their OpenAI client at startup and an
// empty key stops them, failing the deploy. With the placeholder the deploy comes
// up, and only requests fail until the key is set.
//
// Hand-written rather than copied from `.env.example`, which lists every key a
// workflow could take; this is the one it needs.
export const STARTERS = [
  {
    name: 'helloworld',
    // No LLM, so no key, and no `.env` at all: the point of Hello World is that
    // it deploys on a machine that has none.
    env: null,
  },
  {
    name: 'portfolio',
    env: [
      '# Your OpenAI API key, used by IntentAgent and AdvisorAgent.',
      '# Get one at https://platform.openai.com/api-keys, then replace the value below.',
      'OPENAI_API_KEY=REPLACE_WITH_YOUR_API_KEY',
      '',
      '# The model both agents call. Defaults to gpt-4o-mini when unset.',
      '#OPENAI_MODEL_ID=gpt-4o-mini',
    ],
  },
] as const;

/** Copy one workflow into the bundle, renaming its Python so Nuitka leaves it alone. */
function bundleOne(starter: (typeof STARTERS)[number]): void {
  const source = join(repoRoot, 'examples', starter.name);
  if (!existsSync(source)) throw new Error(`examples/${starter.name} does not exist.`);

  const destination = join(bundleDir, starter.name);
  rmSync(destination, { recursive: true, force: true });
  cpSync(source, destination, {
    recursive: true,
    filter: (path: string) => !isSkipped(basename(path)),
  });

  for (const file of walk(destination)) {
    if (file.endsWith('.py')) renameSync(file, `${file}${PYTHON_BUNDLE_SUFFIX}`);
  }

  // A `.env` the user may already have filled in locally is theirs, not ours.
  rmSync(join(destination, '.env'), { force: true });
  if (starter.env) {
    writeFileSync(join(destination, '.env'), `${starter.env.join('\n')}\n`);
  }
}

/** Every file under `directory`, recursively. */
export function walk(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...walk(path));
    else found.push(path);
  }
  return found;
}

/** Rebuild the whole bundle from examples/. */
export function bundleStarters(): string[] {
  rmSync(bundleDir, { recursive: true, force: true });
  mkdirSync(bundleDir, { recursive: true });
  for (const starter of STARTERS) bundleOne(starter);
  return walk(bundleDir)
    .map((path) => relative(bundleDir, path))
    .sort();
}

/** Read every bundled file, so a test can compare one build against the next. */
export function bundleContents(): Record<string, string> {
  if (!existsSync(bundleDir)) return {};
  return Object.fromEntries(
    walk(bundleDir)
      .sort()
      .map((path) => [relative(bundleDir, path), readFileSync(path, 'utf8')])
  );
}

if (import.meta.main) {
  const files = bundleStarters();
  console.log(
    `Bundled ${STARTERS.length} workflows, ${files.length} files, into ${relative(repoRoot, bundleDir)}`
  );
}
