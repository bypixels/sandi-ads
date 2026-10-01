# 6. Snapshot cache + retention + in-memory refresh jobs

Date: 2026-05-21
Status: Accepted

## Context

The Command Center route hits the Site payload endpoint on every page
load. Lighthouse takes 30-90s. The llms.txt probe and SEO audit take
seconds to tens of seconds. Inline execution on a GET was unworkable;
no cache layer existed.

The decisions in this ADR cover **three related design choices** in
`src/dashboard/services/snapshots.ts` and `routes/command-center.ts`:

1. **What the cache stores and how it's keyed**
2. **Retention policy** (when do old captures get dropped)
3. **Async refresh job model** (how the user triggers a re-capture without
   blocking the HTTP connection)

## Decision

### 1. Generic `(siteId, kind)` snapshot store

One table `site_snapshots(id, site_id, kind, data jsonb, captured_at)`.
Kind is a typed union (`SnapshotKind`) with both a const array (for
runtime validation via `isKnownSnapshotKind`) and a derived type.
Adding a kind = one append; no migration (column is generic JSONB).

The repo exposes `getLatest`, `getMany`, `save`, `getOrFresh`,
`invalidate`. `getMany` is implemented as N parallel `getLatest` calls
rather than a `DISTINCT ON` SQL query — equivalent index work, simpler
code, immune to array-parameter escaping issues with Drizzle's `sql`
template tag (an early attempt that failed in smoke test).

### 2. Retention: drop > 30 days BUT always keep latest per (site, kind)

`pruneOlderThan(days)` deletes rows older than the cutoff except those
that are the most recent for their `(site_id, kind)` tuple. A daily
scheduler (`startSnapshotPruner`) runs on boot + every 24h.

### 3. Async refresh with in-memory job state

`POST /api/cc/site/:id/refresh` returns `202 Accepted` with a `jobId`
in milliseconds. The producers (Lighthouse mobile, Lighthouse desktop,
llms.txt probe) run in background via `Promise.allSettled`. The client
polls `GET /refresh/:jobId` every 3s. Per-producer state is exposed
so the UI can render granular progress. Jobs are deduped per-site
(a second POST while one is running returns the same id).

## Consequences

- **Why N parallel `getLatest` over `DISTINCT ON`**: my first attempt
  used `sql\`... WHERE kind = ANY(${kinds})\`` — Drizzle 0.45 expanded
  the array as a row constructor `($2, $3, $4)`, which Postgres
  rejected. The N-call form uses the same `(site_id, kind, captured_at
  DESC)` index, scales with kinds (3-15), not with history, and avoids
  SQL placeholder escaping.

- **Why "keep latest forever"**: the UI's loop is "if a snapshot exists,
  render it with `isStale` styling; otherwise show CTA". Dropping the
  latest when it ages past retention would force users to re-run
  expensive tools just to see anything, even when stale data + warning
  is the better UX.

- **In-memory jobs extend ADR-0001's precedent.** The same trade-off
  applies: jobs die on restart, but the **snapshots they produce are
  durable**. The next page load shows fresh data; the user doesn't
  know a job was lost. Multi-instance deployments would need sticky
  sessions for polling, which is not a concern today.

- **Per-site dedup prevents double Lighthouse runs.** A user that
  refreshes twice in 5 seconds gets one job; the second POST returns
  the same id. The job state Map is keyed by site, not by user, so
  this also serializes multi-user concurrency on the same site.

- **Future explorer should not re-suggest**: "let's persist jobs to
  Postgres so they survive restarts". Until the producers themselves
  are restart-safe (workflow engine, durable queue), persisting only
  job state buys nothing — a job marked 'running' after restart with
  no actual producer is misleading.

- **Future explorer should not re-suggest**: "use DISTINCT ON in
  `getMany`". The N-call form is faster than it sounds (parallel
  index seeks) and immune to a category of escaping bugs.

- **Re-open this ADR when**: (a) we add a snapshot kind whose latest
  capture is genuinely worthless after N days (e.g. real-time-only
  data) — retention needs a per-kind override; (b) producers become
  restart-safe via a workflow engine — job persistence becomes useful.
