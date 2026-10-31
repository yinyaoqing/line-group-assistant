-- Per-person plans: every group bills to an account; plans are free / starter / advanced.

-- Old plan names: Duo (per person) becomes Starter; Pro (per group) becomes Advanced.
UPDATE accounts SET plan = 'starter' WHERE plan = 'duo';
UPDATE accounts SET plan = 'advanced' WHERE plan = 'pro';

-- Groups not yet bound to an account move to their owner's account, created if
-- needed and carrying the group's old paid plan. An owner of several Pro groups
-- keeps the first one's end date; check the admin page after migrating.
INSERT INTO accounts (account_id, channel_id, user_id, plan, plan_until)
SELECT g.channel_id || ':' || a.line_user_id, g.channel_id, a.line_user_id,
       CASE WHEN g.plan = 'pro' THEN 'advanced' ELSE 'free' END,
       CASE WHEN g.plan = 'pro' THEN g.plan_until ELSE NULL END
FROM groups g JOIN admins a ON a.group_id = g.group_id AND a.role = 'owner'
WHERE g.account_id IS NULL
ON CONFLICT (account_id) DO UPDATE SET
  plan = CASE WHEN accounts.plan = 'free' THEN excluded.plan ELSE accounts.plan END,
  plan_until = CASE WHEN accounts.plan = 'free' THEN excluded.plan_until ELSE accounts.plan_until END;

UPDATE groups SET account_id = channel_id || ':' || (
  SELECT line_user_id FROM admins WHERE admins.group_id = groups.group_id AND admins.role = 'owner'
)
WHERE account_id IS NULL
  AND EXISTS (SELECT 1 FROM admins WHERE admins.group_id = groups.group_id AND admins.role = 'owner');

-- Google and DeepL now cost 18 allowance characters each and are no longer offered: move to Claude Haiku.
UPDATE groups SET settings = json_set(settings, '$.translate.engine', 'claude', '$.translate.model', 'claude-haiku-5-5')
WHERE json_extract(settings, '$.translate.engine') IN ('google', 'deepl')
   OR json_extract(settings, '$.translate.engine') IS NULL;

-- Scheduled messages always ride on the next free reply now.
UPDATE groups SET settings = json_remove(settings, '$.core.notify') WHERE json_extract(settings, '$.core.notify') IS NOT NULL;
