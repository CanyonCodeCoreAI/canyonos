// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fixture = mkdtempSync(join(tmpdir(), 'canyonos-promptfoo-'));
const promptfoo = join(import.meta.dir, '..', 'node_modules/.bin/promptfoo');

try {
  const evals = join(fixture, 'evals');
  const skill = join(fixture, '.agents/skills/ui-dev');
  const prompt = join(evals, 'prompts/with-skill.json');
  const tests = join(skill, 'evals/smoke.yaml');
  const config = join(evals, 'promptfooconfig.yaml');

  mkdirSync(join(skill, 'evals'), { recursive: true });
  mkdirSync(join(evals, 'prompts'), { recursive: true });
  symlinkSync(
    join(import.meta.dir, '..', '.agents/skills/ui-dev/SKILL.md'),
    join(skill, 'SKILL.md')
  );
  symlinkSync(join(import.meta.dir, '..', 'evals/prompts/with-skill.json'), prompt);
  writeFileSync(
    tests,
    `- vars:\n    kind: behavior\n    request: Reply with hello.\n    context: \"\"\n    skillSource: file://../.agents/skills/ui-dev/SKILL.md\n  assert:\n    - type: contains\n      value: UI Development\n    - type: contains\n      value: hello\n`
  );
  writeFileSync(
    config,
    `prompts: file://prompts/with-skill.json\nproviders: [echo]\ntests: file://../.agents/skills/ui-dev/evals/smoke.yaml\n`
  );
  mkdirSync(join(fixture, 'state'));

  execFileSync(promptfoo, ['eval', '-c', config, '--no-cache'], {
    cwd: fixture,
    env: {
      ...process.env,
      PROMPTFOO_CONFIG_DIR: join(fixture, 'state'),
      PROMPTFOO_DISABLE_TELEMETRY: 'true',
    },
    timeout: 60000,
    stdio: 'inherit',
  });

  console.log('skills Promptfoo smoke: prompt, YAML tests, and assertions passed');
} finally {
  rmSync(fixture, { recursive: true, force: true });
}
