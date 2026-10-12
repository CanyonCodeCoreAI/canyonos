---
name: ui-dev
description: Build, simplify, or review React interfaces using native HTML/CSS and existing libraries. Use for components, forms, queries, mutations, and UI state ownership.
---

# UI Development

Deliver the requested behavior with the least custom machinery. Let the browser
and installed libraries do the work they already know how to do.

## Choose the owner before writing code

Ask in this order:

1. Do we need JavaScript? Prefer semantic HTML, CSS layout, selectors, native
   attributes, and browser behavior when they express the interaction.
2. Do we need custom React logic? Check the existing component or library API
   first, including its uncontrolled mode, composition, and lifecycle behavior.
3. Do we need new state? Identify what cannot be derived and why its existing
   owner cannot manage it.

Treat `useState` and `useEffect` as pain pills: last resorts, taken only when no
suitable native or library capability can express the behavior. Before adding
either, explain the remaining need and the alternatives considered in the work
summary, not a code comment. Moving the same machinery into a custom hook,
reducer, ref, store, or state machine does not satisfy this rule.

## Server state belongs to TanStack Query

**All application API reads and writes must use TanStack Query.** Call the API
client inside query or mutation functions. Components and effects must not run
independent fetch lifecycles.

- Use query options to colocate query keys, functions, and relevant policies.
  Include the inputs that identify the data in its key.
- Render data, pending, fetching, and error states directly from query results.
  Do not mirror them in component state, stores, reducers, or custom lifecycle
  models. A pure rendering decision derived from a query is fine.
- Use Query's capabilities for caching, deduplication, retries, cancellation,
  polling, dependent queries, pagination, and optimistic updates when needed.
  Do not rebuild them with effects, timers, flags, or custom caches.
- Use mutations for writes. Take pending and error state from the mutation;
  perform cache updates or invalidation in its lifecycle callbacks. Invalidate
  every affected view, including summaries and details.
- Load data where it is consumed. Let primitive-controlled mounting activate
  queries on demand when appropriate; do not add an open-state mirror just to
  start a request. Preserve useful cached content during background refetches.

## Forms and interactions belong to their primitives

- Use react-hook-form for form values, validation, dirty state, and submission.
  Reuse the API's schema through its resolver. Keep request state in the mutation.
- Let Collapsible, Dialog, Tabs, and other existing primitives own their ordinary
  interaction state. Prefer uncontrolled behavior unless external coordination
  actually requires control.
- Style existing state through CSS: `data-state`, `data-active`, `aria-*`,
  `:hover`, `:focus-visible`, `:disabled`, and group selectors. Data attributes
  expose state; they are not a second state store.
- Prefer a class or native visibility attribute for simple presentational slots.
  Use mounting boundaries when lifecycle, lazy work, or resource ownership matters.
  CSS hiding does not stop effects or queries in a mounted component.
- Use native focus, form submission, and keyboard behavior or the primitive's
  accessible implementation before writing handlers. Retain labels, focus
  indicators, and reduced-motion support.
- Reset through the owning library's API or a meaningful component identity.
  A changed key is appropriate only when discarding the subtree's state is intended.

## Build for people and the browser

- Reuse the application's components, tokens, and icon set before adding a local
  visual system. Scope a restyle to the requested surface; do not turn it into a
  product-wide migration.
- Use semantic controls and accessible primitive behavior. Keyboard operation,
  focus movement and return, labels, screen-reader names, zoom, and visible focus
  are requirements of the interaction, not follow-up polish.
- Do not communicate status or validation by color alone. Provide text and the
  correct semantic association with the affected control.
- Express presentation with CSS custom properties, responsive layout, media
  queries, and state selectors. Honor `prefers-reduced-motion`; the interface
  must remain understandable without motion.
- Use JavaScript only for a user preference or behavior that CSS and the
  primitive cannot own. Never synchronize styles between elements with effects.

## Keep one source of truth

- Import domain schemas, types, and parsing helpers from their owning API or
  domain contract. Derive subsets with `Pick`, `Omit`, or schema composition;
  never redeclare mirrored shapes or reinterpret domain identifiers in the UI.
- Calculate derived values during rendering. Handle user actions in event or
  library callbacks. An effect is only for necessary external synchronization
  that an existing integration does not already own, with complete cleanup.
- Reuse shared components, shadcn primitives, and installed icons. Add missing
  shadcn components through its CLI. Check installed versions and official APIs
  before inventing a workaround.
- Keep components focused on meaningful behavior. Extract for reuse or clarity,
  not to hide complexity. Prefer guards, typed lookup maps, or a `switch` over
  nested ternaries and chained `&&` rendering.

## Verify the simplification

Exercise the affected user flow in the running application, including relevant
pending, error, retry, empty, and success behavior. Check keyboard access,
focus, zoom, contrast, reduced motion, and relevant mobile and wide viewports.
Screenshots aid inspection but do not replace interaction checks or create a
screenshot-regression suite unless requested. Check whether closing, reopening,
or refetching preserves or resets state as intended. Test observable behavior
rather than the custom state machinery that the libraries replace. Run repository
checks and report actual results.

For API details, consult the relevant official documentation:
[TanStack Query](https://tanstack.com/query/latest/docs/framework/react/overview),
[react-hook-form](https://react-hook-form.com/docs),
[Radix](https://www.radix-ui.com/primitives/docs/overview/introduction), and
[React effects](https://react.dev/learn/you-might-not-need-an-effect).
