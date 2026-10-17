-- Messages waiting to ride on the group's next reply instead of being pushed:
-- replies are free, pushes count against the LINE message quota. Scheduled
-- sends (the weekly digest) queue here and go out with the next event that
-- carries a reply token (a message, a button tap, a sticker, a join).
CREATE TABLE outbox (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id   TEXT NOT NULL,
  message    TEXT NOT NULL, -- one LINE message object, as JSON
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX outbox_by_group ON outbox (group_id, id);
