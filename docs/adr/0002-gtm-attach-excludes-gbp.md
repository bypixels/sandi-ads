# 2. GTM container attach uses GSC+GA4 domain set, not GBP

Date: 2026-04-27
Status: Accepted

## Context

`google-discovery.ts` runs source fetchers in this order:

1. `fetchGscSites(buckets)` — populates buckets from GSC
2. `fetchGa4Properties(buckets)` — populates from GA4 streams
3. `fetchGtmContainers()` — collects raw container list (does NOT bucket)
4. `fetchAdsCustomers()` — orphans only, no buckets touched
5. `attachGtmContainers(buckets, containers)` — bucketizes GTM via `bestGuessDomain`
6. `fetchGbpLocations(buckets)` — populates from GBP

`attachGtmContainers` reads `Array.from(buckets.keys())` as `knownDomains`
to feed `bestGuessDomain`. Because GBP runs **after** the GTM attach phase,
GBP-only domains are never available as match targets when GTM containers
are being assigned.

## Decision

Keep GTM attach scoped to **GSC + GA4 domains only**. Do not move it
after GBP.

## Consequences

- **Why this is right**: GTM containers are typically installed on a web
  property the team also owns in GSC or GA4. A GBP-only domain (a Google
  Business Profile location pointing at some external site) is rarely
  one the team has GTM access to — matching a GTM container to a
  GBP-only domain would produce false positives.

- **Surface effect**: a GTM container whose name only matches a GBP-only
  domain will appear in `summary.unmatched.gtmAccounts` instead of being
  attached. This is the desired conservative behavior — the user sees
  the orphan and decides whether to attach it manually.

- **Future explorer should not re-suggest**: "move GBP fetcher before
  GTM attach to give GTM matching more candidate domains". Doing so
  would inflate false-positive matches and silently couple GTM
  containers to unrelated GBP locations.

- **The ordering is encoded in the coordinator**, not in the fetchers
  themselves. Tests on individual fetchers must not assume any order;
  the coordinator is the one place where the dependency lives.

- **Re-open this ADR when**: GBP becomes a primary source of canonical
  web properties (e.g. if the team starts using GBP as a CMS-like
  surface). Today GBP is a marketing channel, not a property record.
