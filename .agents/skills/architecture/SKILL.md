---
name: architecture
description: Shape or review software boundaries, ownership, dependencies, and reuse. Use for feature design, module extraction, cross-layer changes, and focused refactors; not for unrelated redesigns.
---

# Architecture

Make the smallest structural decision that gives one clear owner to meaningful
behavior. Favor an existing extension point when it fits; add a boundary only
when it isolates real behavior, a stable contract, or useful reuse.

## Find the owner

- Trace the request from its public boundary to the state and side effects it
  changes. Put rules, contracts, persistence, rendering, and lifecycle behavior
  with their responsible layer.
- Let a platform, protocol, database, or installed library own behavior it
  already guarantees. Do not create a wrapper that only forwards calls or a
  second source of state to compensate for an unclear boundary.
- Keep shared contracts in their owning domain. Consumers import, extend, or
  derive them rather than recreating matching types or schemas.

## Extract only a real boundary

- Reuse existing adjacent patterns when their behavior and constraints match.
  Similar syntax alone does not justify an abstraction.
- A reusable package should not depend on one application's routing, branding,
  or startup wiring. Give it a small explicit API and inject application-specific
  behavior at the edge.
- Prefer a focused refactor that makes the current change simpler over a broad
  framework for hypothetical future cases.
- State the concrete ownership problem, dependency direction, and consumer that
  the boundary improves. If those are unclear, keep the design local.

## Verify the boundary

Check changed callers, public exports, failure ownership, and the real behavior
across the new or adjusted seam. Preserve unrelated architecture; a design task
does not authorize a migration or cleanup outside its scope.
