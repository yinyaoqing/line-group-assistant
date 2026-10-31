import type { GroupConfig } from "../src/core/types";

/**
 * What a newly invited group starts with. The bot registers the group with
 * these values when it joins; change a single group afterwards in the
 * "groups" table (plugins / settings / storage columns are JSON).
 */
export const defaultGroup = (groupId: string, channelId = "default"): GroupConfig => ({
  groupId,
  channelId,
  plan: "free",
  plugins: ["translate", "tasks", "tools", "materials", "culture"],
  storage: { type: "d1" },
  settings: {
    translate: {
      engine: "claude", // Claude Haiku: the cheapest per character, and it can follow a tone; "google" | "deepl" cost ~18× the allowance
      model: "claude-haiku-5-5",
      trigger: "all", // "all": every message; "command": only /t
      showName: true,
      languages: ["zh-TW", "en"], // see config/languages.ts; the plan limits which are usable
      // "all": every language the group chose. "members" (only languages members have written in) leaves a group
      // where everyone writes Chinese with nothing to translate into, and read-only members never get translations.
      targetMode: "all",
    },
    tasks: { digest: false }, // weekly push costs message quota, so off by default
    culture: { leadDays: 2 }, // festival reminders ride on the next free reply, so on by default
  },
});
