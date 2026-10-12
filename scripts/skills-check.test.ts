import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from 'bun:test';

import { engineeringSkills, validateSkills } from './skills-check';

test('engineering skill discovery is structurally valid', () => {
  expect(engineeringSkills).toHaveLength(7);
  expect(validateSkills()).toEqual([]);
});

test('validation reports malformed test YAML and missing skill files', () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'canyonos-skills-'));

  try {
    cpSync(join(import.meta.dir, '..', '.agents'), join(fixtureRoot, '.agents'), {
      recursive: true,
    });
    mkdirSync(join(fixtureRoot, '.claude', 'skills'), { recursive: true });
    for (const name of engineeringSkills) {
      symlinkSync(`../../.agents/skills/${name}`, join(fixtureRoot, '.claude', 'skills', name));
    }

    writeFileSync(join(fixtureRoot, '.agents/skills/ui-dev/evals/tests.yaml'), 'not: [valid');
    rmSync(join(fixtureRoot, '.agents/skills/api-dev/SKILL.md'));

    const errors = validateSkills(fixtureRoot).join('\n');
    expect(errors).toContain('ui-dev: evals/tests.yaml: invalid YAML');
    expect(errors).toContain('api-dev: missing SKILL.md');
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});
