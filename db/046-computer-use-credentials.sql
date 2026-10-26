-- Platform logins the owner hands to computer use (27.10.2026). Values are encrypted on the
-- server (AES-256-GCM, key derived from SESSION_SECRET, platform domain as associated data):
-- database dumps and backups never hold them in clear. The model never receives them; server code
-- fills them on the platform's own https login page when the model calls `log_in`. Additive only.
CREATE TABLE IF NOT EXISTS computer_use_credentials (
  domain text PRIMARY KEY CHECK (domain ~ '^[a-z0-9.-]{3,100}$'),
  username_enc text NOT NULL CHECK (length(username_enc) <= 1000),
  password_enc text NOT NULL CHECK (length(password_enc) <= 1000),
  login_url text NOT NULL DEFAULT '' CHECK (length(login_url) <= 2000),
  last_login_at timestamptz,
  last_login_error text NOT NULL DEFAULT '' CHECK (length(last_login_error) <= 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
