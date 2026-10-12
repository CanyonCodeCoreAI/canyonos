---
name: code-review
description: Review a PR, branch, or local diff for correctness, contract integrity, architecture, and meaningful verification. Report concrete findings; changes and external actions require the user's chosen disposition.
---

# Code Review

Determine whether the change delivers its intended behavior and preserves the
system's contracts. Lead with actionable findings supported by current evidence.

## Establish the review target

- Identify the intended outcome, acceptance criteria, base revision, and actual
  diff. Inspect the branch and existing worktree changes before running checks.
- Read surrounding code and relevant consumers to understand the changed paths.
  Keep findings tied to the change; separate existing problems and broader ideas.
- Apply repository rules and the relevant development skill when available.
  Review the actual final implementation rather than trusting its summary.
- Ask for the user's real workflow when intended behavior is unclear. Continue
  independent checks, but do not turn an assumption into a requirement.

## Review ownership before implementation details

- Does the behavior belong to this layer? Check for consumer workarounds, hidden
  side effects, duplicated contracts, and competing owners of state or resources.
- Can the platform or an installed library own the behavior? Question custom
  machinery that recreates existing capabilities, especially fetch lifecycles,
  interaction state, validation, and persistence coordination.
- Does an abstraction isolate real behavior or provide useful reuse? Flag
  unnecessary indirection when it obscures ownership or creates concrete drift.
- Preserve the requested scope. A review is not permission to redesign unrelated
  architecture or replace working patterns with personal preferences.

## Check reachable behavior

- Trace inputs through validation, access checks, business rules, persistence,
  and responses. Check affected callers and public exports when contracts change.
- Inspect relevant failure paths: missing data, rejected input, concurrent writes,
  partial success, timeout, cancellation, restart, and resource cleanup.
- For UI changes, check the actual interaction, keyboard access, and pending,
  error, empty, and success behavior. Check whether state survives or resets at
  the intended boundary.
- Verify that tests exercise the changed behavior and can detect its failure.
  Passing tests do not establish coverage of a path they never reach.
- Run checks proportional to the change and any repository-required checks. Use
  reproduction, measurements, or precise source reasoning to support findings.
  Missing tools or failed setup are verification gaps, not proof of a code defect.

## Report concrete findings

Order findings by impact. For each, include:

- Severity and exact file/line.
- Trigger or violated contract, with the evidence.
- Consequence for the user or system.
- Smallest acceptable correction at the responsible layer.

Distinguish verified defects, reasoned risks, and unresolved questions. Tie
severity to impact and likelihood. Avoid speculative edge cases, generic
checklists, praise, and stylistic findings without a project rule or concrete cost.
If no actionable findings remain, say so and state any verification limits.

## Choose the disposition before acting

Present findings and recommend **fix here**, **create a follow-up issue**, or
**ignore/discard the finding**. Ask the user to choose before modifying code or
creating an issue, unless they already authorized that disposition for the finding.
Batch related decisions when useful. Ignoring a finding does not mean deleting
or reverting work.

Report locally by default. Posting PR comments, submitting a review, or merging
requires explicit authorization. An approval recommendation is a review result,
not permission to merge.

After authorized corrections, inspect the actual updated diff and rerun affected
checks. Re-review changed areas and their consequences; expand only when the
correction introduces broader risk. Do not repeat resolved findings without new
evidence.
