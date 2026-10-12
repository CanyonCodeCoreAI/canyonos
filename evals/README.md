# Skill evaluations

These Promptfoo evaluations check whether the engineering skills are selected for
the right requests and produce guidance consistent with their instructions. They
evaluate model responses, not a running CanyonOS application or an agent's actual
file edits.

```bash
bun run skills:test  # deterministic structure checks
bun run skills:check # structure checks plus Promptfoo config validation

# Requires OPENAI_API_KEY and makes paid model calls.
bun run skills:eval
bun run skills:eval:view
```

Promptfoo 0.124.1 requires Node.js 22.22 or newer. `bun` is still the
repository package manager; the Promptfoo executable runs on the active Node.js
runtime.

Set `SKILLS_EVAL_MODEL` for the candidate model and
`SKILLS_EVAL_JUDGE_MODEL` for the rubric grader. `skills:eval` writes a local
report to `evals/results/latest.json`; results and Promptfoo state are ignored.

Each skill owns `evals/tests.yaml`: trigger cases test positive and negative
routing, while behavior cases use Promptfoo's built-in `llm-rubric` assertion.
The configuration runs a candidate with the skill and a no-skill baseline so the
results can be compared. It is intentionally conservative: one repeat and two
concurrent requests.

The design was independently implemented after studying
[crutchcorn/skills](https://github.com/crutchcorn/skills) and Promptfoo's
[test-case](https://www.promptfoo.dev/docs/configuration/test-cases/) and
[model-graded assertion](https://www.promptfoo.dev/docs/configuration/expected-outputs/model-graded/llm-rubric/)
documentation. No upstream source files are copied here. GitHub reported no
license for that repository when this integration was inspected.
