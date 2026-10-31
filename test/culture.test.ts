import { afterEach, describe, expect, it, vi } from "vitest";
import { DAILY_CRON, WEEKLY_CRON } from "../config/crons";
import { handleEvent, handleSchedule, type Deps } from "../src/core/dispatcher";
import type { LineApi } from "../src/core/line";
import type { GroupConfig, LineEvent, LineMessage } from "../src/core/types";
import { plugins } from "../src/plugins";
import { dayInTaipei, upcoming } from "../src/plugins/culture";
import { MemoryAdminRepo } from "../src/storage/admins";
import { MemoryCodeRepo } from "../src/storage/codes";
import { MemoryGroupRepo, MemoryUsageMeter } from "../src/storage/groups";
import { MemoryStorage } from "../src/storage/memory";

const GID = "Cgroup";

function setup(group: Partial<GroupConfig> = {}) {
  const replies: LineMessage[][] = [];
  const pushes: LineMessage[][] = [];
  const line: LineApi = {
    reply: async (_t, m) => void replies.push(m),
    push: async (_to, m) => void pushes.push(m),
    groupMemberName: async () => "Joseph",
    groupName: async () => "露營群組",
  };
  const storage = new MemoryStorage();
  const groups = new MemoryGroupRepo([
    {
      groupId: GID,
      status: "active",
      plugins: ["culture"],
      storage: { type: "memory" },
      settings: { translate: { languages: ["zh-TW", "id"] } },
      ...group,
    },
  ]);
  const deps: Deps = {
    env: { LINE_CHANNEL_SECRET: "s", LINE_CHANNEL_ACCESS_TOKEN: "t", DB: {} as D1Database },
    line,
    channel: { id: "default" },
    groups,
    admins: new MemoryAdminRepo(),
    codes: new MemoryCodeRepo(),
    usage: new MemoryUsageMeter(),
    plugins,
    storageFor: () => storage,
    origin: "https://bot.example",
  };
  return { deps, replies, pushes, groups };
}

/** 2026-03-18 09:00 Taipei: two days before Idul Fitri, during Ramadan. */
const NOW = Date.UTC(2026, 2, 18, 1);

const msg = (text: string, timestamp = NOW): LineEvent => ({
  type: "message",
  replyToken: "r",
  timestamp,
  source: { type: "group", groupId: GID, userId: "U1" },
  message: { type: "text", id: "m", text },
});

const textOf = (m: LineMessage | undefined) => (m as { text: string }).text;

afterEach(() => vi.useRealTimers());

describe("upcoming festivals", () => {
  it("lists festivals of the given languages within the window, soonest first, including ones under way", () => {
    const days = upcoming(["id", "zh-TW"], "2026-03-18", 60).map((o) => `${o.festival.name}:${o.inDays}`);
    expect(days).toEqual(["齋戒月開始:-28", "開齋節:2", "清明節:18"]);
  });

  it("rolls fixed-date festivals into next year", () => {
    const [first] = upcoming(["en"], "2026-12-20", 30);
    expect(first?.festival.name).toBe("聖誕節");
    expect(upcoming(["en"], "2026-12-26", 30).map((o) => o.day)).toEqual(["2027-01-01"]);
  });

  it("converts a timestamp to the Taipei calendar day", () => {
    expect(dayInTaipei(Date.UTC(2026, 2, 17, 20))).toBe("2026-03-18");
  });
});

describe("culture plugin", () => {
  it("/culture shows the next festivals of the languages the group uses, with greetings and tips", async () => {
    const { deps, replies } = setup();
    await handleEvent(msg("/culture"), deps);
    const out = textOf(replies[0]?.[0]);
    expect(out).toContain("開齋節");
    expect(out).toContain("2 天後（3/20）");
    expect(out).toContain("Selamat Hari Raya Idul Fitri");
    expect(out).toContain("進行中");
    expect(out).toContain("不吃豬肉");
    expect(out).not.toContain("潑水節");
  });

  it("/culture <language> shows that culture's year", async () => {
    const { deps, replies } = setup();
    await handleEvent(msg("/culture th"), deps);
    const out = textOf(replies[0]?.[0]);
    expect(out).toContain("潑水節");
    expect(out).toContain("不要摸別人的頭");
  });

  it("reminds the group two days ahead on the daily cron, once, and not on the weekly cron", async () => {
    vi.useFakeTimers({ now: NOW });
    const { deps, pushes } = setup();
    await handleSchedule(WEEKLY_CRON, deps, async () => deps.line);
    expect(pushes).toHaveLength(0);
    await handleSchedule(DAILY_CRON, deps, async () => deps.line);
    expect(pushes).toHaveLength(1);
    const out = textOf(pushes[0]?.[0]);
    expect(out).toContain("開齋節");
    expect(out).toContain("mohon maaf lahir dan batin");
    expect(out).toContain("日期可能差一天");
    await handleSchedule(DAILY_CRON, deps, async () => deps.line);
    expect(pushes).toHaveLength(1);
  });

  it("catches up on a festival starting today if the lead-day reminder was missed", async () => {
    vi.useFakeTimers({ now: Date.UTC(2026, 2, 20, 1) });
    const { deps, pushes } = setup();
    await handleSchedule(DAILY_CRON, deps, async () => deps.line);
    expect(textOf(pushes[0]?.[0])).toContain("今天");
  });

  it("stays quiet when nothing is coming up", async () => {
    vi.useFakeTimers({ now: Date.UTC(2026, 6, 1, 1) });
    const { deps, pushes } = setup();
    await handleSchedule(DAILY_CRON, deps, async () => deps.line);
    expect(pushes).toHaveLength(0);
  });
});

describe("weekly digest and the daily cron", () => {
  it("the tasks digest runs only on the weekly cron", async () => {
    const { deps, pushes, groups } = setup({ plugins: ["tasks"], plan: "pro", settings: { tasks: { digest: true } } });
    await handleEvent(msg("/task add 買螺絲"), deps);
    groups.groups[0]!.settings = { tasks: { digest: true } };
    await handleSchedule(DAILY_CRON, deps, async () => deps.line);
    expect(pushes).toHaveLength(0);
    await handleSchedule(WEEKLY_CRON, deps, async () => deps.line);
    expect(textOf(pushes[0]?.[0])).toContain("#1 買螺絲");
  });
});
