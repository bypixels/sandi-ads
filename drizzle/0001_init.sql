-- Initial schema for Website Ops dashboard.
-- Tables: sites, audit_events, conversations, conversation_messages.

CREATE TABLE IF NOT EXISTS sites (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text NOT NULL,
  primary_url  text NOT NULL,
  bindings     jsonb NOT NULL DEFAULT '{}'::jsonb,
  notes        text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_events (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  timestamp       timestamptz NOT NULL DEFAULT now(),
  tool            text NOT NULL,
  site_id         uuid REFERENCES sites(id) ON DELETE SET NULL,
  input           jsonb NOT NULL,
  status          text NOT NULL CHECK (status IN ('success', 'error', 'blocked')),
  duration_ms     integer NOT NULL DEFAULT 0,
  error           text,
  result_summary  text
);

CREATE INDEX IF NOT EXISTS audit_events_timestamp_idx ON audit_events (timestamp DESC);
CREATE INDEX IF NOT EXISTS audit_events_tool_idx      ON audit_events (tool);
CREATE INDEX IF NOT EXISTS audit_events_site_idx      ON audit_events (site_id);

CREATE TABLE IF NOT EXISTS conversations (
  id                            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id                       uuid REFERENCES sites(id) ON DELETE SET NULL,
  title                         text NOT NULL,
  created_at                    timestamptz NOT NULL DEFAULT now(),
  updated_at                    timestamptz NOT NULL DEFAULT now(),
  total_input_tokens            integer NOT NULL DEFAULT 0,
  total_output_tokens           integer NOT NULL DEFAULT 0,
  total_cache_read_tokens       integer NOT NULL DEFAULT 0,
  total_cache_creation_tokens   integer NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS conversations_site_idx    ON conversations (site_id);
CREATE INDEX IF NOT EXISTS conversations_updated_idx ON conversations (updated_at DESC);

CREATE TABLE IF NOT EXISTS conversation_messages (
  conversation_id  uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  seq              integer NOT NULL,
  role             text NOT NULL CHECK (role IN ('user', 'assistant')),
  content          jsonb NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, seq)
);
