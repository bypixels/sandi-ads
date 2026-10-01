# 11. Site profile (marketer metadata) is separate from site bindings

Date: 2026-05-21
Status: Accepted

## Context

A `Site` row needs to carry two distinct kinds of data:

1. **Bindings** — technical wiring the agent uses to call APIs:
   `gscSiteUrl`, `ga4PropertyId`, `gtmAccountId`, `cloudflareZoneId`,
   etc. These are URLs and IDs; they're consumed only by tools.

2. **Profile** — marketer-facing metadata that informs strategy and
   content generation: `description`, `niche`, `brandVoice`, `tags[]`,
   `competitors[{name, url, notes?}]`. These are prose and lists;
   they're consumed by prompts and the Command Center UI.

The original `sites` table had both `bindings: jsonb` and `notes: text`,
where `notes` was where any other metadata went. As the Command Center
added support for editable profile fields, two options appeared:

- **A.** Add more typed columns to `sites` (`description text`,
  `niche text`, `brand_voice text`, `tags text[]`, ...).
- **B.** Stuff everything into `bindings` since it's already JSONB.
- **C.** Add a second JSONB column `profile` with its own module.

Option B couples technical and prose data — every tool reading
bindings would have to ignore the profile keys; every profile editor
would have to preserve binding keys. Option A means every shape change
is a migration.

## Decision

Option **C**: add `profile jsonb` to the `sites` table; create
`src/dashboard/services/site-profile.ts` as the **only** module that
reads or writes that column. Profile shape is owned by a Zod schema
inside that module, with `profileVersion: literal(1)` stamped on every
write to support future migrate-on-read.

`sites-store.ts` continues to own `name`, `primaryUrl`, `bindings`,
`notes`. The two stores coexist on the same row, with clean
responsibility boundaries.

## Consequences

- **Two stores, two responsibilities, one row.** Every caller imports
  the store relevant to its concern. Tools that consume bindings
  never touch `siteProfileRepo`. The profile editor modal in the
  Command Center never touches `sitesStore` for its primary write
  path.

- **Schema versioning lives in code, not in SQL.** Bumping the
  profile shape (`profileVersion: literal(2)`) and adding a
  migrate-on-read branch in `parseProfile()` evolves the structure
  without a database migration. The JSONB column is intentionally
  unstructured at the DB level.

- **Concurrent profile updates are serialized.** `update()` runs
  `SELECT ... FOR UPDATE` inside a transaction so two concurrent PUTs
  to the same site can't lost-write each other. (See `site-profile.ts`
  for the implementation; this was one of the medium-severity issues
  caught in the post-implementation audit and fixed.)

- **Future explorer should not re-suggest**: "merge profile back into
  bindings since both are JSONB — one column is simpler". The single
  column was the original problem. Mixing concerns means every
  consumer has to know which keys are "theirs" — a leaky contract.

- **Future explorer should not re-suggest**: "promote profile fields
  to typed columns now that we know the shape — better SQL queries,
  indices, etc." Most profile reads are "give me the whole record,
  show it in the UI"; there are no analytical queries against
  individual profile fields today. JSONB is the right granularity.

- **Re-open this ADR when**: (a) analytical reporting against
  individual profile fields becomes a hot path (e.g. "all sites
  whose niche contains 'legal'"), and JSONB GIN indexes don't cut
  it; or (b) the profile shape grows binary/large enough (e.g.
  embedded images) that JSONB is the wrong storage primitive.
