---
name: testing
description: Design or review focused tests for changed behavior. Use for regression coverage, test boundaries, integration tests, browser tests, fixtures, and deciding whether a test is warranted.
---

# Testing

Prove the changed behavior at the smallest boundary that can fail in the way a
user or caller would notice. Follow repository-required coverage for changed
features and contracts. Beyond that, add a test for a user-reported bug, a likely
regression in complex behavior, or an explicit request—not merely to grow
coverage.

## Choose the boundary

1. Start with the public behavior: command, endpoint, UI flow, or durable
   integration point.
2. Prefer a focused integration test when collaboration between modules is the
   risk. Use a narrow unit test for a difficult invariant or edge case that does
   not need the full boundary.
3. Use a browser test for behavior that depends on real browser semantics,
   accessibility, layout, or integration—not merely to prove a function call.

Reuse the repository's test stack and fixtures. Do not migrate tooling or invent
a general framework to add one case.

## Test behavior, not the implementation

- Render real UI and drive accessible user interactions; assert observable
  output, not internal state, implementation classes, or hook calls.
- Mock external boundaries only when the real dependency is unavailable,
  expensive, nondeterministic, or unsafe. Do not mock the module whose behavior
  the test is meant to prove.
- Use disposable real infrastructure when persistence, transactions, queries,
  or lifecycle behavior matters. Keep fixtures explicit about setup and cleanup.
- Make asynchronous tests wait on the condition that matters. Bound timeouts and
  retain enough output to diagnose failures.

## Keep the suite useful

Each test should fail for the behavior it names. Include the unhappy path when it
is part of the changed contract, but do not duplicate nearby cases without a new
risk. Run the narrow test first, then repository-required checks, and report
what was not exercised.
