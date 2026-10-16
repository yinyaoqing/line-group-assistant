-- One-time activation codes, issued by platform admins. A code works once, for
-- one channel, until it expires; it can carry a plan that the group starts on.
-- Replaces the shared ACTIVATION_CODE secret and per-channel activation codes.
CREATE TABLE activation_codes (
  code        TEXT PRIMARY KEY,            -- normalised: upper case, no dashes
  label       TEXT NOT NULL DEFAULT '',    -- who it is for, e.g. the customer
  channel_id  TEXT NOT NULL DEFAULT 'default',
  plan        TEXT NOT NULL DEFAULT 'free',
  plan_until  TEXT,                        -- YYYY-MM-DD for paid plans
  expires_at  TEXT,                        -- ISO time; NULL = never
  created_by  TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  used_group  TEXT,
  used_by     TEXT,
  used_at     TEXT
);
