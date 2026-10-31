/**
 * Cron expressions the Worker is triggered on (wrangler.toml [triggers]).
 * Plugins compare `cron` in onSchedule against these, so a plugin that wants
 * a weekly job is not run by the daily trigger.
 */
/** Monday 08:00 Taipei: the weekly task digest. */
export const WEEKLY_CRON = "0 0 * * 1";
/** Every day 09:00 Taipei: festival reminders. */
export const DAILY_CRON = "0 1 * * *";
