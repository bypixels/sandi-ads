CREATE TABLE pending_approvals (
  id uuid PRIMARY KEY,
  site_id uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  owner_id uuid NOT NULL,
  source jsonb NOT NULL,
  action jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'decided', 'consumed')),
  decision jsonb
);
CREATE INDEX pending_approvals_site_status_idx ON pending_approvals(site_id, status, expires_at);
