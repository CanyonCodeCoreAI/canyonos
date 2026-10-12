import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const skillsRoot = '.agents/skills';
const skillNames = readdirSync(skillsRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

const catalog = skillNames
  .map((name) => {
    const skill = readFileSync(join(skillsRoot, name, 'SKILL.md'), 'utf8');
    const description = skill.match(/^---\n[\s\S]*?^description: (.+)$/m)?.[1];

    if (!description) {
      throw new Error(`Missing description in ${name}/SKILL.md`);
    }

    return `- ${name}: ${description}`;
  })
  .join('\n');

const candidateModel = process.env.SKILLS_EVAL_MODEL || 'gpt-5.4-mini';
const judgeModel = process.env.SKILLS_EVAL_JUDGE_MODEL || candidateModel;

/** @type {import('promptfoo').TestSuiteConfig} */
export default {
  description: 'Engineering skill routing and behavior',
  sharing: false,
  prompts: [
    { id: 'file://prompts/with-skill.json', label: 'with-skill' },
    { id: 'file://prompts/without-skill.json', label: 'without-skill' },
  ],
  providers: [
    { id: `openai:responses:${candidateModel}`, label: 'candidate', prompts: ['with-skill'] },
    { id: `openai:responses:${candidateModel}`, label: 'no-skill', prompts: ['without-skill'] },
  ],
  defaultTest: {
    vars: { catalog },
    options: {
      provider: `openai:responses:${judgeModel}`,
      rubricPrompt: 'file://prompts/grader.json',
    },
  },
  tests: ['file://../.agents/skills/*/evals/tests.yaml'],
  evaluateOptions: {
    repeat: 1,
    maxConcurrency: 2,
    cache: false,
    timeoutMs: 120000,
  },
  outputPath: 'evals/results/latest.json',
};
