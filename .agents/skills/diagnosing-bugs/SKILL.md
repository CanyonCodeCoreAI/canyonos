---
name: diagnosing-bugs
description: Investigate reported failures and performance regressions through real workflows, reproducible checks, and evidence. Use for debugging and investigating PR findings; implement fixes only within the user's authorized scope.
---

# Diagnosing Bugs

Turn a reported symptom into a reproducible check, identify its cause, and verify
any authorized fix against the same behavior.

## Establish the workflow and scope

- Distinguish diagnosis from implementation. A request to diagnose or review
  authorizes investigation, not source changes, issue creation, or PR comments.
- Ask the user for the real workflow when it would clarify reproduction: actions
  or commands, relevant inputs, environment, expected result, and actual result.
- Continue safe investigation while waiting for missing workflow details. If they
  are essential to reproduce the symptom, report the gap rather than substitute
  an imagined scenario.

## Reproduce before changing code

- Exercise the reported path with the relevant CLI command, endpoint, browser
  flow, or existing test. Capture the exact symptom and inputs.
- Establish a check that distinguishes the bug from correct behavior. For a
  performance problem, measure a baseline; for an intermittent failure, record
  conditions and reproduction frequency.
- Reduce the scenario only while it still demonstrates the same failure. A
  convenient nearby failure is not proof of the reported bug.
- If reproduction is unavailable, separate source-based findings from hypotheses
  and request the missing environment or captured evidence. Do not claim a
  verified cause or fix.

## Test explanations with evidence

- Trace the relevant boundaries and state ownership. Form plausible hypotheses
  and state what observation would support or disprove each one.
- Use existing logs, traces, query tools, debuggers, and library diagnostics first.
  Add temporary instrumentation only within the authorized scope, targeting the
  uncertainty being tested.
- Change one variable at a time where practical. Record the result and revise
  the hypothesis; do not accumulate speculative patches until the symptom stops.

## Choose the disposition before acting

For PR findings, present the evidence, impact, responsible layer, and recommended
disposition. Ask the user to choose **fix here**, **create a follow-up issue**, or
**ignore/discard the finding** before modifying code or creating an issue.

An explicit request to fix that finding, create its follow-up, or ignore it already
settles the choice; do not request the same authorization again. General review
or diagnosis requests do not settle it. Batch related findings when useful.

Apply the same decision to newly discovered problems outside the approved task.
Ignoring a finding means setting it aside, not deleting or reverting work.

## Fix the responsible layer

- Correct the owner of the broken contract, state, or lifecycle. Avoid consumer
  workarounds that conceal an upstream failure or duplicate responsibility.
- Keep the fix within the chosen scope. Separate broader architecture changes
  from the immediate correction unless they are necessary and authorized.
- When a suitable test boundary exists, capture the reproduction as a regression
  test that fails before the fix and passes afterward. Exercise real behavior
  rather than asserting the shape of the implementation.
- Re-run the original workflow and relevant checks. Remove temporary diagnostics
  and inspect the final diff before reporting completion.

## Report what is known

State the symptom, verified cause or remaining hypotheses, chosen disposition,
and verification results. Distinguish new failures from existing problems. For
diagnosis-only work, stop with the evidence and proposed correction; for fixes,
state what passed and what remains unverified.
