-- GSC alert-like signals derived from API state.
-- Each row is a "currently open" or "previously seen" issue for a site.
-- The watcher upserts open signals and sets resolved_at when conditions clear.

CREATE TABLE IF NOT EXISTS gsc_signals (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  site_id       uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  signal_type   text NOT NULL,
  severity      text NOT NULL CHECK (severity IN ('info', 'low', 'warn', 'high', 'critical')),
  title         text NOT NULL,
  detail        jsonb NOT NULL DEFAULT '{}'::jsonb,
  first_seen    timestamptz NOT NULL DEFAULT now(),
  last_seen     timestamptz NOT NULL DEFAULT now(),
  resolved_at   timestamptz,
  acknowledged  boolean NOT NULL DEFAULT false
);

CREATE INDEX IF NOT EXISTS gsc_signals_site_idx ON gsc_signals (site_id);
CREATE INDEX IF NOT EXISTS gsc_signals_lastseen_idx ON gsc_signals (last_seen DESC);

-- Partial unique index: only one OPEN signal per (site, type).
-- Resolved signals stay as historical rows but don't block new opens.
CREATE UNIQUE INDEX IF NOT EXISTS gsc_signals_open_unique
  ON gsc_signals (site_id, signal_type)
  WHERE resolved_at IS NULL;
