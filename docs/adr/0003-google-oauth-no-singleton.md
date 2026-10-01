# 3. GoogleOAuth owns its own token state — no global TokenManager singleton

Date: 2026-04-27
Status: Accepted

## Context

Originally `src/auth/token-manager.ts` exported a global `tokenManager`
singleton that owned the OAuth credentials, expiry, and refresh-coalescing
Promise. `GoogleOAuth.initializeWithRefreshToken()` mutated this global
as a side effect, and `AuthManager.getAccessToken()` read from it
directly. Net effect: two state objects (`this.oauth: GoogleOAuth` and
the global `tokenManager`) had to stay in sync, and only one OAuth
account could be active at a time.

The codebase is moving toward multi-account: each `Site` row may bind to
its own Google account (DB-stored encrypted refresh tokens). Iteration 1
uses one default-active account; iteration 2 will route per-Site.

## Decision

`GoogleOAuth` owns all its own token state as instance-private fields.
`tokenManager` and `token-manager.ts` are deleted. `AuthManager` reads
from `this.oauth?.getAccessToken(service)` directly.

## Consequences

- **Multi-account becomes mechanically possible**: `new GoogleOAuth(...)`
  can be instantiated per Site without instances pisándose. Each
  instance has its own refresh-coalescing Promise, expiry tracking, and
  scope verification.

- **Tests don't need globals**: a test can `new GoogleOAuth({...})` and
  drive it without resetting global state between cases. The
  refresh-coalescing path becomes testable by triggering two concurrent
  `getAccessToken()` calls.

- **Bug fix included**: when Google omits `refresh_token` on a refresh
  response (which it does on every refresh), the previous singleton
  flow lost the original via `tokenManager.setTokens()` overwrite.
  `GoogleOAuth.applyTokens()` now preserves it explicitly.

- **Future explorer should not re-suggest**: "extract a shared token
  cache so multiple GoogleOAuth instances reuse refreshes". That would
  re-couple instances and lose the per-account isolation we need for
  multi-account.

- **External API**: zero change. Nothing outside `src/auth/` ever
  imported `tokenManager` directly — only `authManager` from
  `auth/index.ts`. The cleanup is purely internal.

- **Re-open this ADR when**: we hit a realistic case where two
  accounts need to share token-refresh state (extremely unlikely —
  refresh tokens are per-account by design).
