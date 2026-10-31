-- Per-user subscriptions (the Duo plan): one account per LINE member, bound to
-- any number of groups, which all bill translation to the account.
CREATE TABLE accounts (
  account_id  TEXT PRIMARY KEY,               -- "<channel_id>:<line user id>"
  channel_id  TEXT NOT NULL DEFAULT 'default',
  user_id     TEXT NOT NULL,                  -- LINE user ID as the bot sees it
  plan        TEXT NOT NULL DEFAULT 'duo',
  plan_until  TEXT,                           -- YYYY-MM-DD, last paid day (Taipei)
  bonus_chars INTEGER NOT NULL DEFAULT 0,     -- top-ups, used after the monthly allowance; never expire
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- A group bound to an account takes the account's plan and bills its usage there.
ALTER TABLE groups ADD COLUMN account_id TEXT;

-- Codes either activate (optionally with a plan) or top up an account's characters.
ALTER TABLE activation_codes ADD COLUMN kind TEXT NOT NULL DEFAULT 'activate'; -- activate | topup
ALTER TABLE activation_codes ADD COLUMN chars INTEGER NOT NULL DEFAULT 0;       -- for topup codes
