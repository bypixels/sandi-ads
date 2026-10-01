-- Drafts — agent-generated artifacts (articles, social posts, replies) that
-- await human review before publishing. Each row is one editable draft.
-- The state machine: pending_review → approved → published (or rejected /
-- revised). Enforced at the repo level, not as a CHECK constraint, so we can
-- evolve transitions without a migration.

CREATE TABLE IF NOT EXISTS drafts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id       uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  agent_id      text NOT NULL,            -- 'writer' | 'social-x' | 'social-linkedin' | 'social-hn' | 'reddit' | ...
  draft_type    text NOT NULL,            -- 'article' | 'reddit_reply' | 'tweet' | 'thread' | 'linkedin_post' | 'hn_comment' | ...
  status        text NOT NULL DEFAULT 'pending_review',
  title         text NOT NULL,
  content       jsonb NOT NULL,           -- structured per draft_type (markdown body, post text, etc.)
  source_ref    jsonb,                    -- what triggered this: { briefId?, signalId?, threadUrl?, articleDraftId? }
  metadata      jsonb NOT NULL DEFAULT '{}'::jsonb,  -- { model, tokens, promptVersion, brandVoiceVersion, ... }
  reviewed_by   text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  reviewed_at   timestamptz,
  published_at  timestamptz
);

-- Inbox queries: list pending drafts per site + agent. ASC on created_at so
-- oldest pending bubbles up.
CREATE INDEX IF NOT EXISTS drafts_site_status_created_idx
  ON drafts (site_id, status, created_at);

-- Agent-feed cross-site queries (e.g. "all writer drafts pending")
CREATE INDEX IF NOT EXISTS drafts_agent_status_idx
  ON drafts (agent_id, status);
