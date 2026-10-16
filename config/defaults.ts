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
  plugins: ["translate", "tasks", "items"],
  storage: { type: "d1" },
  settings: {
    translate: {
      engine: "google", // "google" | "deepl" | "claude"
      trigger: "all", // "all": every message; "command": only /t
      showName: true,
      languages: ["zh-TW", "en"], // see config/languages.ts; the plan limits which are usable
    },
    tasks: { digest: false }, // weekly push costs message quota, so off by default
  },
});
