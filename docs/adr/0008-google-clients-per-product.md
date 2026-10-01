# 8. One `clients.ts` per Google product, not a master factory

Date: 2026-05-21
Status: Accepted

## Context

Each Google product the codebase integrates with (GTM, Search Console,
Analytics, Indexing, Business Profile) needs its own authenticated
`googleapis` client constructed via `google.{service}({ version, auth })`.
Originally each tool file (`gtm/accounts.ts`, `gtm/tags.ts`,
`gtm/triggers.ts`, etc.) defined its own private `getXXXClient()` of
~3 lines with identical bodies — 17 copies across the codebase.

`business-profile/clients.ts` was an existing partial precedent: GBP
had already extracted its client construction (plus `assertBusinessProfileAuth`
and `normalizeLocationName`) into one module.

The deletion test: removing the 17 inline factories concentrates the
"how do we build a GA4 client" question in one place per product —
not zero, and not one global place.

## Decision

Mirror the GBP pattern across the four other Google modules:
- `src/tools/google/gtm/clients.ts` — `getGTMClient()`
- `src/tools/google/search-console/clients.ts` — `getSearchConsoleClient()`
- `src/tools/google/analytics/clients.ts` — three variants
  (`getAnalyticsAdminClient`, `getAnalyticsAdminAlphaClient`, `getAnalyticsDataClient`)
- `src/tools/google/indexing/clients.ts` — `getIndexingClient()`

Tool files import the constructed client. They no longer import
`googleapis` or `getGoogleAuth` directly.

## Consequences

- **One `clients.ts` per product, not one master.** A single
  `clients.ts` at the `google/` level would have to expose a router
  (`getClient(product, version)`) and either return typed-but-narrowed
  clients or untyped ones. The per-product split keeps each factory
  fully typed and lets each product own its own surface (GBP's
  `LocationsClient` cast, Analytics' three version flavors, etc.) in
  one place.

- **Per-product is where cross-cutting concerns will naturally land.**
  Adding request tracing or version pinning for, say, GA4, doesn't
  need to touch GTM. The "edit per product" cost is the same as
  "edit per cross-cutting concern" — both are local.

- **Tool files no longer import `googleapis` directly.** This makes it
  easy to find every Google API call site (`grep` the `clients.ts`
  imports). A future refactor that wraps the SDK (replace it, mock
  it for tests, add interceptors) has one chokepoint per product.

- **Future explorer should not re-suggest**: "consolidate the five
  `clients.ts` files into one master `google/clients.ts`". The
  consolidation hides the per-product surface that matters (GBP's
  legacy resource shapes, Analytics' multi-version API) and gains
  no leverage we can't already achieve via per-product files.

- **Future explorer should not re-suggest**: "let each tool file
  inline its own client again, it's just 3 lines". The 17-fold
  duplication that prompted this ADR is the historical reason.

- **Re-open this ADR when**: a real cross-product concern emerges
  (e.g. a shared retry policy that should apply to all Google APIs)
  AND it can't be implemented inside `executeGoogleApi` (the existing
  wrapper in `api-wrapper.ts` that already centralizes rate-limiting
  + error mapping).
