# 9. `executeToolByName` is the only seam from dashboard layer to tools

Date: 2026-05-21
Status: Accepted

## Context

The dashboard layer invokes tools from several places: the chat agent
loop, the HTTP `/api/tool/:name` route, the GSC monitor's per-site
detectors, the OAuth-flow site-discovery scanner, the Command Center
route handler, and the autopilot SSE stream.

Initially these were inconsistent:

- `dashboard-data.ts` exported `executeToolByName(name, input):
  Promise<unknown>` — the canonical seam.
- `sites-discover.ts:58-64` defined its own private `callTool<T>` that
  reached `getTool()` directly and re-implemented the safeParse →
  handler flow. **It bypassed `executeToolByName`** — any future
  change to validation, error mapping, or telemetry would apply to
  five callers and silently skip one.
- `gsc-monitor.ts:70-72` and `google-discovery.ts:29-31` each defined
  their own one-line wrapper around `executeToolByName` whose only
  purpose was the cast to `Promise<T>`.

The deletion test: deleting the three wrappers + the `getTool` import
concentrates "how a tool gets called" in one place. The wrappers were
adding zero behaviour beyond a type cast.

## Decision

`executeToolByName<T = unknown>(name, input): Promise<T>` is the single
seam. Make it generic so callers can pass `T` once at the call site
without an `as Promise<T>` cast. Internal callers that want a local
short name use `const callTool = executeToolByName;` (truly an alias,
not a re-implementation).

`sites-discover.ts` no longer imports `getTool`; it goes through
`executeToolByName` like every other caller.

## Consequences

- **A change to how tool errors are surfaced now applies uniformly.**
  Adding telemetry, swapping the validation library, mapping
  exceptions to a richer error envelope — one edit, applies to every
  caller. Before this ADR, the sites-discover bypass meant any of
  those changes would silently miss one of the most-exercised paths
  in the codebase.

- **Generic typing is purely ergonomic.** Validation still happens at
  runtime via Zod inside `executeToolByName`. The `<T>` parameter is
  trusted information from the caller about what shape it expects;
  if the tool's handler doesn't actually return that shape (e.g. a
  signature drift), the bug surfaces at the call site, not inside
  the seam.

- **Future explorer should not re-suggest**: "split the seam into
  `executeInternal` (validated, typed) vs `executeExternal` (HTTP
  payload, error-mapped)". The single seam IS the property that makes
  it useful — split it and the duplication problem returns.

- **Future explorer should not re-suggest**: "reach `getTool()`
  directly for performance / to skip validation". The validation is
  cheap (Zod is microseconds), and "skip validation" is exactly the
  hole this ADR exists to close. If a hot-path scenario emerges,
  benchmark first; don't presume the win.

- **Re-open this ADR when**: telemetry / batching / streaming
  requirements arrive that force the seam to expose a richer
  result shape (durations, retries, partial results) and the
  single-function interface can't accommodate them via a third
  parameter. Today the four-line interface is enough.
