import { existsSync, lstatSync, readFileSync, readlinkSync, realpathSync } from 'node:fs';
import { join } from 'node:path';

export const engineeringSkills = [
  'api-dev',
  'architecture',
  'code-review',
  'diagnosing-bugs',
  'python-systems',
  'testing',
  'ui-dev',
] as const;

function addError(errors: string[], condition: boolean, message: string): void {
  if (!condition) errors.push(message);
}

function readYaml(path: string, label: string, errors: string[]): unknown {
  try {
    return Bun.YAML.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    errors.push(
      `${label}: invalid YAML (${error instanceof Error ? error.message : String(error)})`
    );
    return undefined;
  }
}

export function validateSkills(root = join(import.meta.dir, '..')): string[] {
  const errors: string[] = [];

  for (const name of engineeringSkills) {
    const skillPath = join(root, `.agents/skills/${name}`);
    const skillFile = join(skillPath, 'SKILL.md');
    const metadataFile = join(skillPath, 'agents/openai.yaml');
    const testsFile = join(skillPath, 'evals/tests.yaml');
    const claudePath = join(root, `.claude/skills/${name}`);

    addError(errors, existsSync(skillFile), `${name}: missing SKILL.md`);
    addError(errors, existsSync(metadataFile), `${name}: missing agents/openai.yaml`);
    addError(errors, existsSync(testsFile), `${name}: missing evals/tests.yaml`);
    addError(
      errors,
      existsSync(claudePath) && lstatSync(claudePath).isSymbolicLink(),
      `${name}: .claude entry must be a symlink`
    );

    if (existsSync(skillFile)) {
      const skill = readFileSync(skillFile, 'utf8');
      addError(
        errors,
        skill.startsWith(`---\nname: ${name}\n`),
        `${name}: frontmatter name must match directory`
      );
      addError(errors, /^description: .+/m.test(skill), `${name}: missing frontmatter description`);
    }

    if (existsSync(metadataFile)) {
      const metadata = readYaml(metadataFile, `${name}: agents/openai.yaml`, errors);
      const interfaceConfig =
        metadata && typeof metadata === 'object'
          ? (metadata as { interface?: Record<string, unknown> }).interface
          : undefined;
      addError(errors, Boolean(interfaceConfig), `${name}: metadata needs interface`);
      addError(
        errors,
        typeof interfaceConfig?.display_name === 'string' &&
          interfaceConfig.display_name.length > 0,
        `${name}: metadata needs display_name`
      );
      addError(
        errors,
        typeof interfaceConfig?.short_description === 'string' &&
          interfaceConfig.short_description.length >= 25 &&
          interfaceConfig.short_description.length <= 64,
        `${name}: short_description must be 25-64 characters`
      );
      addError(
        errors,
        typeof interfaceConfig?.default_prompt === 'string' &&
          interfaceConfig.default_prompt.includes(`$${name}`),
        `${name}: default_prompt must name the skill`
      );
    }

    if (existsSync(testsFile)) {
      const tests = readYaml(testsFile, `${name}: evals/tests.yaml`, errors);
      const cases = Array.isArray(tests) ? tests : [];
      const triggers = cases.filter((testCase) => {
        const metadata =
          testCase && typeof testCase === 'object'
            ? (testCase as { metadata?: { kind?: unknown } }).metadata
            : undefined;
        return metadata?.kind === 'trigger';
      });
      const behavior = cases.find((testCase) => {
        const metadata =
          testCase && typeof testCase === 'object'
            ? (testCase as { metadata?: { kind?: unknown } }).metadata
            : undefined;
        return metadata?.kind === 'behavior';
      }) as { assert?: Array<{ type?: unknown }> } | undefined;
      addError(
        errors,
        triggers.some(
          (testCase) => (testCase as { vars?: { shouldLoad?: unknown } }).vars?.shouldLoad === true
        ),
        `${name}: missing positive routing case`
      );
      addError(
        errors,
        triggers.some(
          (testCase) => (testCase as { vars?: { shouldLoad?: unknown } }).vars?.shouldLoad === false
        ),
        `${name}: missing negative routing case`
      );
      addError(
        errors,
        Boolean(behavior?.assert?.some((assertion) => assertion.type === 'llm-rubric')),
        `${name}: missing behavior rubric`
      );
    }

    if (existsSync(claudePath) && lstatSync(claudePath).isSymbolicLink() && existsSync(skillPath)) {
      const target = readlinkSync(claudePath);
      addError(
        errors,
        target === `../../.agents/skills/${name}`,
        `${name}: .claude symlink target is not relative canonical path`
      );
      addError(
        errors,
        realpathSync(claudePath) === realpathSync(skillPath),
        `${name}: .claude symlink does not resolve to canonical skill`
      );
    }
  }

  return errors;
}

if (import.meta.main) {
  const errors = validateSkills();

  if (errors.length > 0) {
    console.error(errors.map((error) => `skills check: ${error}`).join('\n'));
    process.exit(1);
  }

  console.log(
    `skills check: ${engineeringSkills.length} engineering skills are structurally valid`
  );
}
