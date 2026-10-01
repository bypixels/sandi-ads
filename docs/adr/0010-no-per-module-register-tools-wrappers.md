# 10. No per-module `register*Tools()` wrappers; one flat registration

Date: 2026-05-21
Status: Accepted

## Context

Each tool module (`monitoring`, `security`, `seo-technical`, ...) used
to export both a `*Tools` array and a `register*Tools()` function. The
top-level `src/tools/index.ts` called every `register*Tools()` in
sequence. 18 identical 3-line wrappers across the codebase. Adding a
new module required edits in three places: the module's index, the
top-level import list, and the top-level call list.

Each wrapper also created a circular value import — every module
imported `registerTool` from `../index.js`, the very module that
imported the module's `*Tools` array. ES modules handle this, but it
spooks tools and complicates dead-code analysis.

Three options were considered:

- **A. Status quo** — keep the wrappers, accept the duplication.
- **B. Drop wrappers, keep arrays** — each module exports `*Tools`
  only; top-level iterates a flat array of spreads.
- **C. Dynamic imports** — top-level holds a list of
  `() => import('./X/index.js')` and dispatches at boot.

## Decision

Option **B**. Each module exports its `*Tools` array; nothing more.
`src/tools/index.ts` spreads all the arrays into one and calls
`registerTool` for each. The 18 wrapper functions are deleted; the
circular `registerTool` import disappears.

## Consequences

- **Explicit imports preserved.** Unlike option C (dynamic imports
  with side-effect registration), every module that contributes
  tools is named in the top-level imports. Dead-code analysis,
  type-checking, and IDE jump-to-definition all work normally. Tree
  shaking is unaffected.

- **Circular value imports are gone.** Modules no longer depend on
  `../index.js`. The dependency graph becomes a clean tree:
  `tools/index.ts → */index.ts → individual tool files`.

- **Adding a new module is two edits**: create the module with its
  `*Tools` array, add one `import` + one spread in
  `src/tools/index.ts`. Down from three edits (module register fn +
  top-level import + top-level call).

- **Idempotency stays a property of `registerTool`.** Calling
  `registerAllTools()` twice writes the same tools into the registry
  twice; since `Map.set` overwrites with the same value, this is a
  no-op. We don't depend on this but it's nice for tests.

- **Future explorer should not re-suggest** (option A): "let's restore
  the per-module register functions for plugin-style extensibility
  — a third-party module could declare its own register fn". This
  is a real concern for a plugin system, but the codebase has no
  external tool authors today. When (if) we add plugin support, the
  shape will be different (probably a manifest + dynamic load),
  not a per-module wrapper.

- **Future explorer should not re-suggest** (option C): "use dynamic
  imports so modules can register themselves on first load".
  Side-effect imports break tree shaking, confuse linters, and the
  load-time gain is illusory because everything imports at boot
  anyway.

- **Re-open this ADR when**: we introduce a plugin or extension
  surface that lets non-core code contribute tools at runtime. At
  that point the registration shape needs to support late binding,
  which neither this ADR nor its alternatives currently address.
