# 4. Business Profile rate limit is 10 QPM internally, regardless of Google's published quota

Date: 2026-04-27
Status: Accepted

## Context

`src/types/config.ts` sets per-service rate limits used by Bottleneck
to spread requests internally. Google publishes a 60 QPM quota for
`mybusinessbusinessinformation.googleapis.com` on default projects,
but the actual enforced quota for `mybusinessaccountmanagement.googleapis.com`
on new/unverified projects is often **1 QPM** — orders of magnitude
lower than what's published.

Setting our internal limit to 60 QPM (matching Google's documentation)
caused the discovery flow to burn through the actual project quota in
seconds. Symptom: `Quota exceeded for quota metric 'Requests' and
limit 'Requests per minute'` 429s during what should be a routine
account survey.

## Decision

Set `businessProfile: { requests: 10, window: 60000 }` (10 QPM). Do
not raise to match Google's published number unless the user has
explicitly increased their Google project quota AND validated it.

## Consequences

- **Bottleneck `minTime` becomes ~6 seconds** between requests, which
  paces discovery and ad-hoc tool calls below the realistic project
  quota for most users.

- **Trade-off**: a `gbp_list_accounts` followed immediately by N
  `gbp_list_locations` calls will be sequential with 6s spacing.
  For a user with 5 GBP accounts this adds ~30s to discovery. This
  is acceptable — discovery is a manual, infrequent action.

- **The 429 path is still preserved**: `executeGoogleApi` maps Google's
  429 to `MCPError.rateLimitError` with `retryAfter` deduced from the
  message ("per minute" → 60s, "per hour" → 3600s, "per day" → 86400s).
  So even if our 10 QPM is too high for a particular project, the
  caller gets a clean error with a wait hint.

- **Future explorer should not re-suggest**: "raise to 60 QPM, that
  matches Google's documented quota". Google's published numbers are
  upper bounds for verified high-volume projects; the floor for
  default projects is much lower. The setting reflects empirical
  reality, not documentation.

- **Re-open this ADR when**: we add a way for users to declare their
  actual Google project quota in `.env` (e.g. `GOOGLE_BUSINESS_QPM=60`),
  letting them opt into faster pacing.
