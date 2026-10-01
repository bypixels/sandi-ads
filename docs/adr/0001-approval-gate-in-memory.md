# 1. Approval gate is in-memory only — no DB persistence

Date: 2026-04-27
Status: Accepted

## Context

The approval gate (`src/dashboard/services/approval-gate.ts`) holds pending
mutation approvals — actions the agent or GSC monitor wants to execute that
need user consent. Each pending approval lives in a `Map<string, PendingEntry>`
with a 5-minute TTL.

If the dashboard process restarts while an approval is unresolved:
- the Promise the caller is awaiting dies
- the `Map` is wiped
- the UI sees a stale `approval_required` event with nobody listening

It's tempting to persist approvals to Postgres so they survive restarts.

## Decision

Keep the approval gate **in-memory only**. Do not persist to Postgres.

## Consequences

- **Why this is fine**: the gate's only callers (`agent.ts` SSE loop, future
  GSC monitor autopilot) are themselves not restart-safe. The agent loop
  drops its SSE stream on process exit; a turn cannot resume across a
  restart. The GSC monitor scans on a fixed interval and would re-detect
  the same condition next cycle. Persisting approvals without persisting
  their consumers buys nothing — the resolved decision would have nowhere
  to flow back to.

- **Future explorer should not re-suggest**: "let's persist approvals to
  Postgres so they survive restarts". Until the agent loop and monitor
  cycle become restart-safe (durable conversation queues, idempotent
  cycle replay), approval persistence is solving the wrong half of the
  problem.

- **Re-open this ADR when**: we introduce durable agent execution (e.g.
  workflow engine, Durable Objects, Inngest-style step replay). At that
  point the gate's persistence story has to match the consumer's.

- **Cost of being wrong**: an approval pending at restart auto-denies via
  TTL after 5 min. The user retries the action. Acceptable.
