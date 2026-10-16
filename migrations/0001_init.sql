-- Groups the bot has joined. A group registers itself as 'pending' when the bot
-- is invited, and runs plugins only once it is 'active' (/activate <code>).
CREATE TABLE groups (
  group_id   TEXT PRIMARY KEY,
  name       TEXT,
  status     TEXT NOT NULL DEFAULT 'pending', -- pending | active
  plugins    TEXT NOT NULL,                   -- JSON array of plugin names
  settings   TEXT NOT NULL DEFAULT '{}',      -- JSON: { [plugin]: { ... } }
  storage    TEXT NOT NULL DEFAULT '{"type":"d1"}', -- JSON: {"type":"d1"} | {"type":"sheets","sheetId":"…"}
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Plugin tables (tasks, translate, …) for groups using D1 storage: one row per
-- record, fields as a JSON object, ids numbered per group and table.
CREATE TABLE records (
  group_id TEXT NOT NULL,
  tbl      TEXT NOT NULL,
  id       INTEGER NOT NULL,
  data     TEXT NOT NULL,
  PRIMARY KEY (group_id, tbl, id)
);

-- Last id handed out per group and table; bumped atomically so concurrent
-- appends never share an id.
CREATE TABLE counters (
  group_id TEXT NOT NULL,
  tbl      TEXT NOT NULL,
  last_id  INTEGER NOT NULL,
  PRIMARY KEY (group_id, tbl)
);

-- Metered usage per group and month (YYYY-MM, Taipei time), e.g. translate_chars.
CREATE TABLE usage (
  group_id TEXT NOT NULL,
  month    TEXT NOT NULL,
  metric   TEXT NOT NULL,
  amount   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (group_id, month, metric)
);
