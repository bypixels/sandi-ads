-- Linked Google accounts. Each row is a Google identity that authorized us
-- via OAuth. Refresh token is encrypted at the application layer using the
-- same passphrase as credential-store.

CREATE TABLE IF NOT EXISTS google_accounts (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email                       text NOT NULL UNIQUE,
  name                        text,
  picture_url                 text,
  encrypted_refresh_token     text NOT NULL,
  encryption_iv               text NOT NULL,
  encryption_tag              text NOT NULL,
  scopes                      text[] NOT NULL DEFAULT '{}',
  is_active                   boolean NOT NULL DEFAULT true,
  last_validated_at           timestamptz,
  last_used_at                timestamptz,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS google_accounts_active_idx
  ON google_accounts (is_active) WHERE is_active = true;

-- Optional binding from a Site to the Google account that owns its data.
-- When NULL, AuthManager uses the default (first active) account.
ALTER TABLE sites
  ADD COLUMN IF NOT EXISTS google_account_id uuid REFERENCES google_accounts(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS sites_google_account_idx ON sites (google_account_id);
