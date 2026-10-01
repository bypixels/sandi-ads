-- Snapshot cache for expensive tool outputs (Lighthouse, llms.txt probe, etc.)
-- and editable Site profile fields (description, niche, brand voice, tags,
-- competitors) separate from technical bindings.

CREATE TABLE IF NOT EXISTS site_snapshots (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  site_id      uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  kind         text NOT NULL,
  data         jsonb NOT NULL,
  captured_at  timestamptz NOT NULL DEFAULT now()
);

-- Fast latest-by-kind lookup
CREATE INDEX IF NOT EXISTS site_snapshots_site_kind_captured_idx
  ON site_snapshots (site_id, kind, captured_at DESC);

-- Editable marketer-facing site metadata. Empty {} default = unset.
-- Bindings stay in their own column for technical wiring.
ALTER TABLE sites
  ADD COLUMN IF NOT EXISTS profile jsonb NOT NULL DEFAULT '{}'::jsonb;
