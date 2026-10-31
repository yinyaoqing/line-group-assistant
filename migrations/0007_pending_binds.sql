-- A settings link opened by a LINE Login account that is not provably the admin
-- who asked for it (white-label channels live in another provider, so the two
-- user IDs differ) waits here until that admin confirms with /confirm <code>
-- in the group. Rows expire with the link.
CREATE TABLE pending_binds (
  code          TEXT PRIMARY KEY,            -- 6 digits, shown on the settings page
  group_id      TEXT NOT NULL,
  line_user_id  TEXT NOT NULL,               -- the admin the link was issued to
  login_sub     TEXT NOT NULL,               -- the LINE Login account waiting to be bound
  login_name    TEXT NOT NULL DEFAULT '',    -- shown in the group when confirmed
  expires_at    TEXT NOT NULL,               -- ISO time
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX pending_binds_admin ON pending_binds (group_id, line_user_id);
