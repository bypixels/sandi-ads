-- Social posts — own publishing queue for Facebook + Instagram organic posts.
-- Phase 2a only creates drafts and records a durable human approval; nothing
-- is sent to Meta. The publishing worker (phase 2b) consumes 'approved' rows.
-- Transitions are enforced by services/social-posts-store.ts with atomic
-- UPDATE ... WHERE status = ANY(...) AND site_id = ...; the CHECKs below only
-- keep values inside the known vocabulary. Duplicate platforms are refused by
-- the app (validateDraft + store dedupe): Postgres CHECKs cannot use subqueries.
-- site_id is ON DELETE RESTRICT: deleting a client must never erase its
-- publishing history (the dashboard answers 409 instead).

CREATE TABLE IF NOT EXISTS social_posts (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id                uuid NOT NULL REFERENCES sites(id) ON DELETE RESTRICT,
  platforms              text[] NOT NULL
    CHECK (cardinality(platforms) >= 1 AND platforms <@ ARRAY['facebook', 'instagram']::text[]),
  message                text NOT NULL DEFAULT '',
  image_url              text,
  image_key              text,
  scheduled_at           timestamptz,           -- NULL = as soon as possible after approval
  status                 text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'approved', 'rejected', 'cancelled', 'publishing', 'published', 'failed', 'needs_review', 'late')),
  created_by             text NOT NULL,         -- 'dashboard' | 'mcp' | 'agent'
  approved_by            text,
  approved_at            timestamptz,
  decision_note          text,
  remote_ids             jsonb NOT NULL DEFAULT '{}'::jsonb,  -- { facebook?: postId, instagram?: mediaId }
  last_error             text,
  version                integer NOT NULL DEFAULT 1,  -- optimistic lock: bumped on every edit/decision
  publishing_started_at  timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);

-- Worker scan: approved posts that are due.
CREATE INDEX IF NOT EXISTS social_posts_status_scheduled_idx
  ON social_posts (status, scheduled_at);

-- Per-client queue listing, newest first.
CREATE INDEX IF NOT EXISTS social_posts_site_created_idx
  ON social_posts (site_id, created_at DESC);
