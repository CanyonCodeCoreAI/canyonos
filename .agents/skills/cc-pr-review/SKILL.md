---
name: cc-pr-review
description: Use when asked to review, judge, re-review or get a CanyonOS pull request ready to merge, including PRs already merged that need a second look, triage of the open PR queue, or a review handed to a separate worktree session.
---

# CanyonOS PR Review

The reviewer is a judge, not the author's second pair of hands. The owner
merges every PR on GitHub and decides each finding's fate. Evidence comes
from the real CLI against a real deploy; a green unit suite is not evidence.

## Roles

- **Owner**: merges, chooses fix / follow-up / discard, gives the green light
  for Linear issues and for pushing to the PR branch.
- **Judge** (the session): plans, delegates, cross-checks, writes the verdict.
  For a large or contract-changing PR, the judge reads no diff itself: every
  read, test, deploy, docs audit and fix is a subagent with a narrow brief
  (goal, files, what is ruled out, evidence to return as command + output),
  run in parallel, asked for evidence for and against.
- **Workers**: the subagents. One of them audits docs and skills, separately.

One Orca worktree per PR, never the owner's main checkout. A review handed
to another session gets [the brief template](references/review-brief.md),
filled in: the brief is that session's only context.

## Sequence

1. **Part 1, then wait.** Report what the PR does, its stated goal, the
   contract it changes (manifest keys, containers, CLI commands, examples,
   docs, the porting skill), whether `main` moved under it, and the test
   plan. Stop until the owner answers; "I need it today" shortens nothing.
2. **Land it locally.** `git checkout <head>`, merge `origin/main` into it
   in the worktree, resolve faithfully to both sides, report every conflicting
   hunk. Review what would actually land. The merge commit is pushed to the
   PR branch only when the owner says "push"; "merge it" or "get it in" is
   not that word, and the owner merges the PR on GitHub.
3. **Real infra.** Build `canyonos-core:<tag>` from the merged branch; run
   `canyonos validate`, `deploy --serve false`, `status`, `doctor`, `test`,
   `quit` with `CANYONOS_ENV=development CANYONOS_CORE_IMAGE=<tag>` on a copy
   of `examples/helloworld` (no LLM) and, when the path matters, `portfolio`
   (Bedrock keys, or read the CI "E2E" run). `validate` runs inside the core
   image: a stale image gives false findings. `bun run api:test:e2e` when
   `packages/api` changes. One deploy per machine: take
   `bash .agents/skills/cc-pr-review/scripts/deploy-lock.sh acquire <tag>`
   before `deploy`, `release` after `quit`, and wait when it is held.
   Containers named `canyonos-<other project>-*` belong to someone else.
   Deploy copies of the examples from a scratch folder, with `api_port`,
   `dashboard_port` and `redis_port` that `docker ps --format '{{.Ports}}'`
   does not show.
4. **Architecture, as its own part,** when the PR moves ownership or a
   contract: who owns it now, what leaks outside the new boundary, what a
   third implementation would have to touch, what a user with the old layout
   must do, what runtime behavior rode in with the refactor.
5. **Docs and skills.** A separate worker checks `docs/`, `README.md`,
   `examples/*/README.md`, `skills/*/SKILL.md`, `.agents/skills/**`: nothing
   may contradict the change; it need not mention it. The porting skill is
   what `canyonos build` installs, so a stale instruction there is a must-fix.
6. **Gates last.** `bun run check`, `bun run test`, CI green on the PR.
7. **Verdict.** One list ordered by severity, each item with its evidence,
   then architecture, docs, nits, follow-up candidates. "Must fix in this
   PR" and "already on `main`, Linear candidate" are separate headings.

## What counts

- Findings: valid input breaks; state left half-applied; behavior silently
  changed; existing projects, examples, docs or the skill contradicted.
- Not findings: invalid config failing fast; a backfill for stored data while
  no production exists; anything already broken on `main` (list it as a
  follow-up candidate instead). A bug on `main` the owner asks about in the
  same breath gets its own `fix/<slug>` branch and PR, after the review,
  never a commit on the PR under review.
- Tests: unit tests prove the lines do not throw. New coverage goes to
  `tests/e2e/run.sh` with a `tests/e2e/break_manifest.py` mode, or to
  `packages/cli/tests/e2e`. Existing unit tests a fix breaks are updated.

## After the verdict

- Dispositions attach to findings. An instruction given before the verdict
  exists ("fix as you go", "push the merge", "merge it") attaches to nothing:
  deliver the verdict and ask again against the list.
- Comments on the PR: inline, plain, command + output, no praise, no summary.
  Reply to bot threads only to discard them.
- "Fix" from the owner means: fix on the PR branch, one commit per logical
  change, one-line message under 100 chars, no AI mention, no `.md` unless
  asked, `docs/architecture/CLI.md` never. List commits afterwards, rerun the
  real-infra steps the fix touches, get CI green, report "ready for you to
  merge". Never `gh pr merge`, never push to `main`.
- Nothing in Linear until the owner says so.

## Red flags

- "CI is green and it has tests" as evidence.
- Fixing, pushing or filing before the owner chose a disposition.
- Reading the whole diff yourself on a 100-file PR.
- A verdict spread over chat instead of one severity-ordered list.
- Testing against `canyonos-core:dev` built from another branch.
