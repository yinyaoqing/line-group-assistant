-- Which LINE official account (channel) a group belongs to, and its plan.
ALTER TABLE groups ADD COLUMN channel_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE groups ADD COLUMN plan TEXT NOT NULL DEFAULT 'free';
ALTER TABLE groups ADD COLUMN plan_until TEXT; -- YYYY-MM-DD, last paid day (Taipei); NULL = no end

-- Group admins. line_user_id is the member's ID as the bot sees it; login_sub is
-- their LINE Login ID, bound the first time they open the settings page from a
-- /settings link (the two differ when the bot and LIFF are under different providers).
CREATE TABLE admins (
  group_id     TEXT NOT NULL,
  line_user_id TEXT NOT NULL,
  login_sub    TEXT,
  role         TEXT NOT NULL DEFAULT 'admin', -- owner | admin
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (group_id, line_user_id)
);
CREATE INDEX admins_by_login ON admins (login_sub);

-- White-label channels: a customer's own LINE official account, served at
-- /webhook/<channel_id>. Secret and token are AES-GCM encrypted with APP_SECRET.
CREATE TABLE channels (
  channel_id      TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  secret_enc      TEXT NOT NULL,
  token_enc       TEXT NOT NULL,
  join_policy     TEXT NOT NULL DEFAULT 'open', -- open: groups activate on join | code: need activation_code
  activation_code TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Settings links are single-use: a nonce is recorded when it is redeemed.
CREATE TABLE used_nonces (
  nonce   TEXT PRIMARY KEY,
  used_at TEXT NOT NULL DEFAULT (datetime('now'))
);
