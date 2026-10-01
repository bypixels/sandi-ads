# 5. Guarded tool execution lives in one composition module

Date: 2026-05-21
Status: Accepted

## Context

Every dashboard-initiated tool call that might mutate external state goes
through the same four-step pipeline: env-level policy check → maybe
approval gate → execute → audit-log append. Until this point the
composition was inlined in two places — the agent loop
(`agent.ts:340-455`) and the HTTP route (`api.ts:155-211`) — with slight
drift between them.

The drift was real and security-relevant:

- The agent enforced the approval gate. The HTTP route bypassed it
  entirely, on the implicit theory that the API key authenticates the
  caller and is itself a form of consent.
- The audit-log writes resolved `siteId` differently (HTTP read
  `x-site-id` header; agent read `req.siteId`).
- The two error-mapping branches diverged (HTTP returned the message
  verbatim; agent wrapped errors into `tool_result` blocks for the LLM).

Adding a new pre-execution check (rate-limit, dry-run, scope check) would
have required two edits, and the failure mode of forgetting one was a
genuine security gap rather than a cosmetic bug.

## Decision

Extract the composition into `src/dashboard/services/guarded-execution.ts`
behind one function: `guardedExecute(toolName, input, context, hooks?)`.
Both callers go through it. The agent loop passes hooks to emit its
SSE events at each stage; the HTTP route passes no hooks and reads
the final result.

The pipeline is **source-aware**: `context.source.kind === 'http'`
skips the approval gate (API-key auth IS the implicit user approval);
`kind === 'agent'` consults the approval gate unless `isAutoApproved`.

## Consequences

- **Hooks chosen over async generator** for the staged-events problem.
  Async generators in TypeScript have ergonomic friction (return-type
  inference, finally semantics), and the call sites that need staging
  (just one — agent.ts) handle 3-4 distinct events naturally as
  callbacks. A future caller that wants different stages just passes
  different hook implementations.

- **HTTP-skips-approval is now an explicit policy**, not an oversight.
  The decision lives in code (one if-branch in the pipeline) instead
  of being a property of the call site. If we ever want HTTP to also
  go through approval (for example, multi-user dashboards where the
  API key is shared), we change `kind === 'agent'` to a context flag.

- **Result-rendering concerns stayed in their callers.** The pipeline
  returns `{ status, result, error, durationMs }` — what the agent
  does with it (truncate for the LLM, scan for prompt injection,
  emit `tool_result` SSE) and what HTTP does (status code mapping)
  are not pipeline concerns. The seam stays small.

- **Future explorer should not re-suggest**: "lift more of the agent's
  per-tool rendering into the pipeline so the agent loop shrinks
  further". The rendering is LLM-specific and would couple the
  pipeline to the agent's wire format. The pipeline is for guarding,
  not for shaping output.

- **Re-open this ADR when**: a third caller appears with materially
  different policy needs (e.g. autopilot wants a "dry-run" mode that
  records intended audit rows without executing), and we can't add it
  with another hook or context flag without polluting the interface.
