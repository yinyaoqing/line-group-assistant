import { describe, expect, it, vi } from "vitest";
import { handleEvent, handleSchedule, parseCommand, type Deps } from "../src/core/dispatcher";
import { verifySignature, type LineApi } from "../src/core/line";
import type { GroupConfig, LineEvent, LineMessage } from "../src/core/types";
import { plugins } from "../src/plugins";
import { detectLang } from "../src/plugins/translate/detect";
import { engines } from "../src/plugins/translate/engines";
import { parseAdd } from "../src/plugins/tasks";
import { MemoryAdminRepo } from "../src/storage/admins";
import { MemoryGroupRepo, MemoryUsageMeter } from "../src/storage/groups";
import { MemoryStorage } from "../src/storage/memory";

const GID = "Cgroup";

function setup(group: Partial<GroupConfig> = {}, env: Partial<Deps["env"]> = {}) {
  const replies: LineMessage[][] = [];
  const pushes: LineMessage[][] = [];
  const line: LineApi = {
    reply: async (_t, m) => void replies.push(m),
    push: async (_to, m) => void pushes.push(m),
    groupMemberName: async () => "Joseph",
    groupName: async () => "工班群組",
  };
  const storage = new MemoryStorage();
  const groups = new MemoryGroupRepo([
    {
      groupId: GID,
      status: "active",
      plugins: ["translate", "tasks"],
      storage: { type: "memory" },
      settings: { translate: { engine: "claude" } },
      ...group,
    },
  ]);
  const usage = new MemoryUsageMeter();
  const admins = new MemoryAdminRepo();
  const fullEnv = { LINE_CHANNEL_SECRET: "s", LINE_CHANNEL_ACCESS_TOKEN: "t", ANTHROPIC_API_KEY: "k", DB: {} as D1Database, ...env };
  const deps: Deps = {
    env: fullEnv,
    line,
    channel: { id: "default", joinPolicy: "code", activationCode: fullEnv.ACTIVATION_CODE },
    groups,
    admins,
    usage,
    plugins,
    storageFor: () => storage,
    origin: "https://bot.example",
  };
  return { deps, replies, pushes, storage, groups, usage, admins, line };
}

const msg = (text: string, groupId = GID): LineEvent => ({
  type: "message",
  replyToken: "r",
  timestamp: Date.UTC(2026, 9, 15),
  source: { type: "group", groupId, userId: "U1" },
  message: { type: "text", id: "m", text },
});

const textOf = (m: LineMessage | undefined) => (m as { text: string }).text;

describe("signature", () => {
  it("accepts a valid HMAC and rejects a forged one", async () => {
    const body = '{"events":[]}';
    // expected = base64(HMAC_SHA256("secret", body)), computed with WebCrypto here
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode("secret"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const sig = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)))));
    expect(await verifySignature("secret", body, sig)).toBe(true);
    expect(await verifySignature("secret", body + " ", sig)).toBe(false);
    expect(await verifySignature("secret", body, null)).toBe(false);
  });
});

describe("parseCommand", () => {
  it("splits name and args", () => {
    expect(parseCommand("/task add 買螺絲")).toEqual({ name: "task", args: ["add", "買螺絲"], rest: "add 買螺絲" });
    expect(parseCommand("hello")).toBeNull();
  });

  it("accepts a full-width slash and a capitalised name, as phone keyboards type them", () => {
    expect(parseCommand("／Task Done 1")).toEqual({ name: "task", args: ["Done", "1"], rest: "Done 1" });
  });
});

describe("detectLang", () => {
  it.each([
    ["如果不會太麻煩奕叡老師", "zh"],
    ["Zace 應該載得下，只是要多跑幾趟", "zh"],
    ["The timber looks fine", "en"],
    ["OK", "en"],
    ["👍👍", "skip"],
    ["250", "skip"],
    ["https://example.com/a", "skip"],
  ])("%s → %s", (input, expected) => expect(detectLang(input)).toBe(expected));
});

describe("translate plugin", () => {
  it("replies with the English translation and the sender name", async () => {
    const { deps, replies } = setup();
    const spy = vi.spyOn(engines, "claude").mockResolvedValue("Hello everyone");
    await handleEvent(msg("大家好"), deps);
    expect(spy).toHaveBeenCalledWith("大家好", "en", expect.anything(), expect.anything());
    expect(textOf(replies[0]?.[0])).toBe("🌐 Joseph：Hello everyone");
    spy.mockRestore();
  });

  it("translates English into Traditional Chinese", async () => {
    const { deps } = setup();
    const spy = vi.spyOn(engines, "claude").mockResolvedValue("好");
    await handleEvent(msg("Sounds good"), deps);
    expect(spy.mock.calls[0]?.[1]).toBe("zh-TW");
    spy.mockRestore();
  });

  it("only translates /t messages in command mode", async () => {
    const { deps, replies } = setup({ settings: { translate: { engine: "claude", trigger: "command", showName: false } } });
    const spy = vi.spyOn(engines, "claude").mockResolvedValue("Thanks");
    await handleEvent(msg("謝謝"), deps);
    expect(replies).toHaveLength(0);
    await handleEvent(msg("/t 謝謝"), deps);
    expect(textOf(replies[0]?.[0])).toBe("🌐 Thanks");
    spy.mockRestore();
  });

  it("warns once per window when the engine fails, but always for /t", async () => {
    const { deps, replies } = setup();
    const spy = vi.spyOn(engines, "claude").mockRejectedValue(new Error("Claude 400"));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await handleEvent(msg("大家好"), deps);
    await handleEvent(msg("明天見"), deps);
    expect(replies).toHaveLength(1);
    expect(textOf(replies[0]?.[0])).toContain("翻譯暫時無法使用");
    await handleEvent(msg("/t 謝謝"), deps);
    expect(replies).toHaveLength(2);
    spy.mockRestore();
    err.mockRestore();
  });

  it("turns automatic translation off and on, keeping /t available", async () => {
    const { deps, replies, storage } = setup({ groupId: "Ctoggle" });
    const spy = vi.spyOn(engines, "claude").mockResolvedValue("Hi");
    const m = (t: string) => msg(t, "Ctoggle");
    await handleEvent(m("/translate off"), deps);
    expect(textOf(replies[0]?.[0])).toContain("已關閉");
    expect((await storage.list("translate"))[0]?.enabled).toBe("false");
    await handleEvent(m("大家好"), deps);
    expect(spy).not.toHaveBeenCalled();
    await handleEvent(m("/t 大家好"), deps);
    expect(spy).toHaveBeenCalledTimes(1);
    await handleEvent(m("/translate on"), deps);
    await handleEvent(m("大家好"), deps);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(await storage.list("translate")).toHaveLength(1);
    spy.mockRestore();
  });

  it("does not translate commands", async () => {
    const { deps } = setup();
    const spy = vi.spyOn(engines, "claude").mockResolvedValue("x");
    await handleEvent(msg("/task"), deps);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe("tasks plugin", () => {
  it("parses owner and due date", () => {
    expect(parseAdd("載木料 owner:Zace due:10/20")).toEqual({ title: "載木料", owner: "Zace", due: "10/20" });
  });

  it.each([
    ["買早餐 @JOJO 10/17", { title: "買早餐", owner: "JOJO", due: "10/17" }],
    ["@JOJO 買早餐", { title: "買早餐", owner: "JOJO", due: undefined }],
    ["買早餐 10-17", { title: "買早餐", owner: undefined, due: "10/17" }],
    ["買早餐 2026/10/17", { title: "買早餐", owner: undefined, due: "2026/10/17" }],
    ["寄信給 a@b.com", { title: "寄信給 a@b.com", owner: undefined, due: undefined }],
    ["買 2x4 木料 10/17 送到 5/6 號", { title: "買 2x4 木料 10/17 送到 5/6 號", owner: undefined, due: undefined }],
    ["10/17", { title: "10/17", owner: undefined, due: undefined }],
  ])("parses shorthand %s", (input, expected) => expect(parseAdd(input)).toEqual(expected));

  it("adds, starts, completes and lists tasks", async () => {
    const { deps, replies } = setup({ plugins: ["tasks"] });
    await handleEvent(msg("/task add 去農場看木料 due:10/22"), deps);
    expect(textOf(replies[0]?.[0])).toContain("#1 去農場看木料 [未開始] 👤Joseph ⏰10/22");
    await handleEvent(msg("/task start 1"), deps);
    expect(textOf(replies[1]?.[0])).toContain("[進行中]");
    await handleEvent(msg("/task done 1"), deps);
    await handleEvent(msg("/task"), deps);
    expect(textOf(replies[3]?.[0])).toContain("沒有未完成");
  });

  it("supports phone shortcuts: /add, /todo card buttons and quick replies", async () => {
    const { deps, replies } = setup({ plugins: ["tasks"] });
    await handleEvent(msg("/add 買早餐 @JOJO 10/17"), deps);
    const added = replies[0]?.[0] as { text: string; quickReply: { items: { action: { text: string } }[] } };
    expect(added.text).toContain("#1 買早餐 [未開始] 👤JOJO ⏰10/17");
    expect(added.quickReply.items.map((i) => i.action.text)).toEqual(["/task start 1", "/task done 1", "/todo", "/template", "/help"]);

    await handleEvent(msg("／Todo"), deps);
    const card = replies[1]?.[0] as { type: string; altText: string };
    expect(card.type).toBe("flex");
    expect(card.altText).toContain("#1 買早餐");
    const sent = JSON.stringify(card).match(/"text":"\/task (?:start|done) \d+"/g);
    expect(sent).toEqual(['"text":"/task start 1"', '"text":"/task done 1"']);

    await handleEvent(msg("/task Done 1"), deps);
    expect(textOf(replies[2]?.[0])).toContain("[完成]");
  });

  it("pushes a weekly digest only when enabled and tasks are open", async () => {
    const { deps, pushes, groups } = setup({ plugins: ["tasks"], plan: "pro" });
    await handleEvent(msg("/task add 買螺絲"), deps);
    await handleSchedule("0 0 * * 1", deps, async () => deps.line);
    expect(pushes).toHaveLength(0);
    groups.groups[0]!.settings = { tasks: { digest: true } };
    await handleSchedule("0 0 * * 1", deps, async () => deps.line);
    expect(textOf(pushes[0]?.[0])).toContain("#1 買螺絲");
  });
});

describe("group registration and activation", () => {
  const join = (groupId: string): LineEvent => ({ type: "join", replyToken: "r", timestamp: 0, source: { type: "group", groupId } });

  it("registers an invited group as pending and ignores it until activated", async () => {
    const { deps, replies, groups } = setup({}, { ACTIVATION_CODE: "open-sesame" });
    await handleEvent(join("Cnew"), deps);
    expect(await groups.get("Cnew")).toMatchObject({ status: "pending", name: "工班群組", plugins: ["translate", "tasks", "tools", "materials"] });
    expect(textOf(replies[0]?.[0])).toContain("/activate");

    await handleEvent(msg("/todo", "Cnew"), deps);
    expect(replies).toHaveLength(1);

    await handleEvent(msg("/activate wrong", "Cnew"), deps);
    expect(textOf(replies[1]?.[0])).toContain("錯誤");
    await handleEvent(msg("/activate open-sesame", "Cnew"), deps);
    expect(textOf(replies[2]?.[0])).toContain("已啟用");
    expect((await groups.get("Cnew"))?.status).toBe("active");

    await handleEvent(msg("/todo", "Cnew"), deps);
    expect(textOf(replies[3]?.[0])).toContain("沒有未完成");
  });

  it("refuses chat activation when no code is configured", async () => {
    const { deps, replies, groups } = setup();
    await handleEvent(join("Cnew"), deps);
    await handleEvent(msg("/activate anything", "Cnew"), deps);
    expect(textOf(replies[1]?.[0])).toContain("尚未開放");
    expect((await groups.get("Cnew"))?.status).toBe("pending");
  });

  it("shows the ID of an unknown group on /id", async () => {
    const { deps, replies } = setup();
    await handleEvent(msg("hello", "Cother"), deps);
    expect(replies).toHaveLength(0);
    await handleEvent(msg("/id", "Cother"), deps);
    expect(textOf(replies[0]?.[0])).toContain("Cother");
  });
});

describe("translation quota", () => {
  it("counts translated characters and stops at the monthly limit", async () => {
    const { deps, replies, usage } = setup({ groupId: "Cquota", settings: { translate: { engine: "claude", monthlyChars: 5 } } });
    const spy = vi.spyOn(engines, "claude").mockResolvedValue("Hello");
    await handleEvent(msg("大家早安喔", "Cquota"), deps);
    expect(await usage.get("Cquota", "translate_chars")).toBe(5);
    await handleEvent(msg("明天見", "Cquota"), deps);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(textOf(replies[1]?.[0])).toContain("額度已用完");
    spy.mockRestore();
  });
});
