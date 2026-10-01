# 7. AgentCatalog owns both UI categorization and prompt rendering of signals

Date: 2026-05-21
Status: Accepted

## Context

Signals (alerts from `gsc-monitor.ts`) reach humans through two surfaces:

1. **The Command Center UI** groups them by "agent" (SEO Agent, GEO Agent,
   Content Agent, etc.) with severity-colored cards.
2. **The agent's system prompt** lists them as markdown bullets so the LLM
   knows what's open and can investigate when the user asks.

Initially the categorization (`signalType → agent`) lived only in
client-side JS (`AGENT_DEFS` in `index.html`), and the prompt-side
bullet rendering lived in `agent.ts:173-188`. Two separate places that
formatted the same data with the same severity conventions.

The problem the duplication created:

- The monitor wrote `signalType: 'coverage_high_excluded'` as free text.
- The frontend's `AGENT_DEFS` hardcoded the same string. A rename
  broke the UI silently — the agent simply showed 0 open issues.
- Severity-label conventions could drift between UI ("HIGH") and prompt
  ("**[HIGH]**") without either side noticing.

## Decision

`src/dashboard/services/agent-catalog.ts` is the **single seam** through
which signals reach any human-facing surface. It owns:

- `SIGNAL_KINDS` — runtime const array; `SignalKind` is the derived type
- `SIGNAL_TO_AGENT` — closed map `Record<SignalKind, AgentId>` enforced
  by the compiler
- `AGENT_DEFS` — display name, icon, severity-builder, suggested actions
- `buildAgentSummary(signals)` / `buildAgentDetail(agentId, signals)` —
  consumed by the UI route
- `formatSignalsForPrompt(signals)` — consumed by the agent system prompt

The monitor imports `SignalKind` and writes via
`signalType: 'coverage_high_excluded' satisfies SignalKind` so a typo
or rename fails compilation.

## Consequences

- **Producer ↔ consumer drift is closed at compile time.** Renaming a
  kind requires updating the catalog, which then forces every caller
  (typed write at the monitor, typed read at the route, typed
  prompt-render in agent.ts) to follow. The compiler tells you what
  else to touch.

- **Severity labels stay synchronized.** When the prompt format
  switches from `**[HIGH]**` to something else, only the catalog
  changes; the UI's badge color and the prompt's bullet prefix come
  from the same place.

- **Unknown signals surface, not silently drop.** `buildAgentSummary`
  calls `log.warn('Signals dropped from agent summary', { kinds })`
  when it sees an unrecognized `signalType`. Before this seam existed,
  signals with renamed types appeared as `openCount=0` in the UI with
  no log trace.

- **Future explorer should not re-suggest**: "move
  `formatSignalsForPrompt` into agent.ts where it's used — the
  catalog should only own categorization". Doing so re-opens the
  drift path. The catalog's job is to be the seam through which
  signals reach humans, including the LLM-as-human-proxy.

- **Re-open this ADR when**: a third human-facing surface for signals
  appears (e.g. email digest, Slack notification) and a generic
  `Signal → rendered form` abstraction starts to make sense beyond
  the two it owns today.
