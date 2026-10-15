import type { GroupConfig } from "../src/core/types";

/**
 * One entry per LINE group. To get a group's ID, add the bot to the group
 * (it replies with the ID on join) or send "/id" in the group.
 */
export const groups: GroupConfig[] = [
  {
    groupId: "C00000000000000000000000000000000", // ← 換成你的群組 ID / replace with your group ID
    name: "環樹木平台 Tree Platform",
    plugins: ["translate", "tasks"],
    storage: { type: "sheets", sheetId: "YOUR_SPREADSHEET_ID" },
    settings: {
      translate: {
        engine: "claude",
        trigger: "all",
        showName: true,
        glossary: "Zace = Zace; 收頭樑 = trimmer beam; 格柵 = joist; 南方松 = southern yellow pine; 奕叡老師 = Teacher Yirui",
      },
      tasks: { digest: true },
    },
  },
];
