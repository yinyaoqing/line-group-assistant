import { describe, expect, it, vi } from "vitest";
import { effectivePlan, PLANS } from "../config/plans";
import { handleApi, type ApiDeps } from "../src/api";
import { decrypt, encrypt, signToken, verifyToken } from "../src/core/crypto";
import { handleEvent, type Deps } from "../src/core/dispatcher";
import type { LineApi } from "../src/core/line";
import type { GroupConfig, LineEvent, LineMessage } from "../src/core/types";
import { plugins } from "../src/plugins";
import { detectScript } from "../src/plugins/translate/detect";
import { engines } from "../src/plugins/translate/engines";
import { MemoryAdminRepo } from "../src/storage/admins";
import { MemoryChannelRepo } from "../src/storage/channels";
import { MemoryCodeRepo } from "../src/storage/codes";
import { MemoryGroupRepo, MemoryUsageMeter } from "../src/storage/groups";
import { MemoryStorage } from "../src/storage/memory";

const SECRET = "test-app-secret";

function world(groups: GroupConfig[] = [], channel: Deps["channel"] = { id: "default", joinPolicy: "code" }) {
  const replies: LineMessage[][] = [];
  const line: LineApi = {
    reply: async (_t, m) => void replies.push(m),
    push: async () => {},
    groupMemberName: async (_g, u) => ({ U1: "Joseph", U2: "JOJO" })[u] ?? "Someone",
    groupName: async () => "工班",
  };
  const repo = new MemoryGroupRepo(groups);
  const admins = new MemoryAdminRepo();
  const usage = new MemoryUsageMeter();
  const storage = new MemoryStorage();
  // A one-time code "CODE-123" that the activation tests use.
  const codes = new MemoryCodeRepo();
  codes.codes.push({ code: "CODE123", label: "test", channelId: "default", plan: "free" });
  const deps: Deps = {
    env: { LINE_CHANNEL_SECRET: "s", LINE_CHANNEL_ACCESS_TOKEN: "t", DB: {} as D1Database, APP_SECRET: SECRET, LIFF_ID: "123-abc", GOOGLE_TRANSLATE_API_KEY: "k" },
    line,
    channel,
    groups: repo,
    admins,
    codes,
    usage,
    plugins,
    storageFor: () => storage,
    origin: "https://bot.example",
  };
  const api = (overrides: Partial<ApiDeps> = {}): ApiDeps => ({
    env: { ...deps.env, PLATFORM_ADMINS: "boss" },
    groups: repo,
    admins,
    channels: new MemoryChannelRepo(),
    codes,
    usage,
    plugins,
    lineFor: async () => line,
    verifyIdToken: async (t) => (t.startsWith("ok:") ? { sub: t.slice(3), name: t.slice(3) } : undefined),
    origin: "https://bot.example",
    storageFor: () => storage,
    ...overrides,
  });
  return { deps, replies, repo, admins, usage, api, codes };
}

const msg = (text: string, userId = "U1", groupId = "Cg", mention?: string[]): LineEvent => ({
  type: "message",
  replyToken: "r",
  timestamp: 0,
  source: { type: "group", groupId, userId },
  message: { type: "text", id: "m", text, mention: mention && { mentionees: mention.map((u) => ({ index: 0, length: 1, userId: u })) } },
});
const textOf = (m: LineMessage | undefined) => (m as { text: string }).text;
const active = (over: Partial<GroupConfig> = {}): GroupConfig => ({
  groupId: "Cg",
  status: "active",
  plan: "free",
  plugins: ["translate", "tasks"],
  storage: { type: "memory" },
  settings: { translate: { engine: "google" } },
  ...over,
});

describe("detectScript", () => {
  it.each([
    ["明天早上九點開工", "zh-TW"],
    ["Hôm nay trời đẹp quá", "vi"],
    ["สวัสดีครับ", "th"],
    ["おはようございます", "ja"],
    ["Selamat pagi semua", "latin"],
    ["👍", "skip"],
  ])("%s → %s", (text, expected) => expect(detectScript(text)).toBe(expected));
});

describe("multi-language translation", () => {
  it("translates into every other language of the group, one reply with flags", async () => {
    const w = world([active({ plan: "pro", settings: { translate: { engine: "google", languages: ["zh-TW", "en", "vi"] } } })]);
    const spy = vi.spyOn(engines, "google").mockImplementation(async (_t, target) => ({ text: `[${target}]` }));
    await handleEvent(msg("大家早安"), w.deps);
    expect(spy.mock.calls.map((c) => c[1]).sort()).toEqual(["en", "vi"]);
    expect(textOf(w.replies[0]?.[0])).toBe("🌐 Joseph\n🇺🇸 [en]\n🇻🇳 [vi]");
    expect(await w.usage.get("Cg", "translate_chars")).toBe(8); // 4 chars × 2 calls
    spy.mockRestore();
  });

  it("lets the engine identify an ambiguous Latin-script message and skips that language", async () => {
    const w = world([active({ plan: "pro", settings: { translate: { engine: "google", languages: ["zh-TW", "en", "id"] } } })]);
    const spy = vi.spyOn(engines, "google").mockImplementation(async (_t, target) => ({ text: `[${target}]`, detected: "id" }));
    await handleEvent(msg("Selamat pagi semua"), w.deps);
    expect(spy.mock.calls.map((c) => c[1])).toEqual(["zh-TW", "en"]);
    expect(textOf(w.replies[0]?.[0])).toBe("🌐 Joseph\n🇹🇼 [zh-TW]\n🇺🇸 [en]");
    spy.mockRestore();
  });

  it("drops languages the plan does not include", async () => {
    const w = world([active({ plan: "free", settings: { translate: { engine: "google", languages: ["zh-TW", "en", "vi"] } } })]);
    const spy = vi.spyOn(engines, "google").mockResolvedValue({ text: "Good morning" });
    await handleEvent(msg("大家早安"), w.deps);
    expect(spy.mock.calls.map((c) => c[1])).toEqual(["en"]);
    spy.mockRestore();
  });
});

describe("plans", () => {
  it("fall back to free after the paid-until day, in Taipei time", () => {
    expect(effectivePlan("pro", "2026-10-31", new Date("2026-10-31T15:00:00Z")).id).toBe("pro"); // 23:00 Taipei
    expect(effectivePlan("pro", "2026-10-31", new Date("2026-10-31T16:30:00Z")).id).toBe("free"); // Nov 1 Taipei
    expect(effectivePlan("pro", undefined).id).toBe("pro");
    expect(effectivePlan("bogus", undefined)).toBe(PLANS.free);
  });
});

describe("admins and activation", () => {
  it("makes the activating member the owner; others can be added by @mention", async () => {
    const w = world([active({ status: "pending" })]);
    await handleEvent(msg("/activate code123"), w.deps);
    expect(textOf(w.replies[0]?.[0])).toContain("你是這個群組的管理員");
    expect(await w.admins.get("Cg", "U1")).toMatchObject({ role: "owner" });

    await handleEvent(msg("/admin add @JOJO", "U1", "Cg", ["U2"]), w.deps);
    expect(await w.admins.get("Cg", "U2")).toMatchObject({ role: "admin" });
    await handleEvent(msg("/admin"), w.deps);
    expect(textOf(w.replies[2]?.[0])).toContain("👑 Joseph");

    // Non-admins cannot change admins; admins cannot remove the owner.
    await handleEvent(msg("/admin add @X", "U9", "Cg", ["U9"]), w.deps);
    expect(textOf(w.replies[3]?.[0])).toContain("只有管理員");
    await handleEvent(msg("/admin remove @Joseph", "U2", "Cg", ["U1"]), w.deps);
    expect(textOf(w.replies[4]?.[0])).toContain("只有擁有者");
  });

  it("lets the first /activate claim an already-active group with no admins", async () => {
    const w = world([active()]);
    await handleEvent(msg("/activate code123"), w.deps);
    expect(await w.admins.get("Cg", "U1")).toMatchObject({ role: "owner" });
    await handleEvent(msg("/activate code123", "U2"), w.deps);
    expect(textOf(w.replies[1]?.[0])).toContain("已啟用");
    expect(await w.admins.get("Cg", "U2")).toBeUndefined();
  });

  it("activates groups on join for open white-label channels", async () => {
    const w = world([], { id: "acme", joinPolicy: "open" });
    await handleEvent({ type: "join", replyToken: "r", timestamp: 0, source: { type: "group", groupId: "Cnew" } }, w.deps);
    expect(await w.repo.get("Cnew")).toMatchObject({ status: "active", channelId: "acme" });
    expect(textOf(w.replies[0]?.[0])).toContain("第一位輸入 /activate");
    await handleEvent(msg("/activate", "U1", "Cnew"), w.deps);
    expect(await w.admins.get("Cnew", "U1")).toMatchObject({ role: "owner" });
  });

  it("marks a group as left when the bot is removed", async () => {
    const w = world([active()]);
    await handleEvent({ type: "leave", timestamp: 0, source: { type: "group", groupId: "Cg" } }, w.deps);
    expect((await w.repo.get("Cg"))?.status).toBe("left");
  });
});

describe("/settings link", () => {
  it("is only for admins and carries a signed, single-use token", async () => {
    const w = world([active()]);
    await handleEvent(msg("/settings"), w.deps);
    expect(textOf(w.replies[0]?.[0])).toContain("只有管理員");

    await w.admins.add("Cg", "U1", "owner");
    await handleEvent(msg("/settings"), w.deps);
    const tpl = w.replies[1]?.[0] as { template: { actions: { uri: string }[] } };
    const uri = new URL(tpl.template.actions[0]!.uri);
    expect(uri.origin + uri.pathname).toBe("https://liff.line.me/123-abc");
    const link = await verifyToken<{ g: string; u: string }>(SECRET, "link", uri.searchParams.get("link"));
    expect(link).toMatchObject({ g: "Cg", u: "U1" });
  });
});

describe("crypto", () => {
  it("signs tokens per purpose and rejects tampering or expiry", async () => {
    const t = await signToken(SECRET, "session", { sub: "a" }, 60);
    expect(await verifyToken(SECRET, "session", t)).toMatchObject({ sub: "a" });
    expect(await verifyToken(SECRET, "link", t)).toBeUndefined();
    expect(await verifyToken("other", "session", t)).toBeUndefined();
    expect(await verifyToken(SECRET, "session", t.slice(0, -2) + "xx")).toBeUndefined();
    expect(await verifyToken(SECRET, "session", await signToken(SECRET, "session", {}, -1))).toBeUndefined();
  });

  it("round-trips encrypted credentials", async () => {
    const enc = await encrypt(SECRET, "channel-token");
    expect(enc).not.toContain("channel-token");
    expect(await decrypt(SECRET, enc)).toBe("channel-token");
  });
});

describe("settings API", () => {
  const call = async (deps: ApiDeps, method: string, path: string, body?: unknown, session?: string) => {
    const res = await handleApi(
      new Request("https://bot.example" + path, {
        method,
        headers: { "Content-Type": "application/json", ...(session ? { Authorization: "Bearer " + session } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      deps,
    );
    return { status: res.status, data: (await res.json()) as Record<string, any> };
  };

  it("binds an admin through a /settings link, then lets them read and change settings", async () => {
    const w = world([active()]);
    await w.admins.add("Cg", "U1", "owner");
    const api = w.api();
    const link = await signToken(SECRET, "link", { g: "Cg", u: "U1", n: "nonce-1" }, 600);

    expect((await call(api, "POST", "/api/session", { idToken: "bad", link })).status).toBe(401);
    const s = await call(api, "POST", "/api/session", { idToken: "ok:login-1", link });
    expect(s.data).toMatchObject({ groupId: "Cg", sub: "login-1" });
    // Same link again from a different account is refused.
    expect((await call(api, "POST", "/api/session", { idToken: "ok:login-2", link })).status).toBe(400);

    const session = s.data.session as string;
    expect((await call(api, "GET", "/api/me", undefined, session)).data.groups).toEqual([
      { groupId: "Cg", name: undefined, status: "active", plan: "free", role: "owner" },
    ]);
    const view = await call(api, "GET", "/api/groups/Cg", undefined, session);
    expect(view.data.translate.languages).toEqual(["zh-TW", "en"]);
    expect(view.data.admins).toEqual([{ role: "owner", linked: true, name: "Joseph" }]);

    // Free plan: Vietnamese and the weekly digest are refused.
    expect((await call(api, "PUT", "/api/groups/Cg/settings", { translate: { languages: ["zh-TW", "vi"] } }, session)).status).toBe(403);
    expect((await call(api, "PUT", "/api/groups/Cg/settings", { tasks: { digest: true } }, session)).status).toBe(403);
    const ok = await call(api, "PUT", "/api/groups/Cg/settings", { plugins: ["translate"], translate: { trigger: "command", glossary: "a = b", minLength: 3 } }, session);
    expect(ok.status).toBe(200);
    expect(await w.repo.get("Cg")).toMatchObject({ plugins: ["translate"], settings: { translate: { engine: "google", trigger: "command", glossary: "a = b", minLength: 3 } } });

    // Not this account's group, and no platform rights.
    await w.repo.register({ ...active({ groupId: "Cother" }) });
    expect((await call(api, "GET", "/api/groups/Cother", undefined, session)).status).toBe(403);
    expect((await call(api, "GET", "/api/admin/groups", undefined, session)).status).toBe(403);
    expect((await call(api, "GET", "/api/me")).status).toBe(401);
  });

  it("lets platform admins set plans and add white-label channels with encrypted credentials", async () => {
    const w = world([active()]);
    const channels = new MemoryChannelRepo();
    const api = w.api({ channels });
    const session = (await call(api, "POST", "/api/session", { idToken: "ok:boss" })).data.session as string;

    expect((await call(api, "PUT", "/api/admin/groups/Cg", { plan: "pro", planUntil: "2099-12-31", monthlyChars: 1000 }, session)).status).toBe(200);
    expect(await w.repo.get("Cg")).toMatchObject({ plan: "pro", planUntil: "2099-12-31", settings: { translate: { monthlyChars: 1000 } } });
    expect((await call(api, "PUT", "/api/admin/groups/Cg", { plan: "gold" }, session)).status).toBe(400);

    const created = await call(api, "POST", "/api/admin/channels", { channelId: "Acme", name: "Acme", secret: "sec", token: "tok", joinPolicy: "open" }, session);
    expect(created.data).toEqual({ channelId: "acme", webhookUrl: "https://bot.example/webhook/acme" });
    const stored = await channels.get("acme");
    expect(stored?.secretEnc).not.toBe("sec");
    expect(await decrypt(SECRET, stored!.tokenEnc)).toBe("tok");
    expect((await call(api, "POST", "/api/admin/channels", { channelId: "default", name: "x", secret: "s", token: "t" }, session)).status).toBe(400);
  });

  it("only accepts the dev sign-in when DEV_MODE is on", async () => {
    const w = world();
    expect((await call(w.api(), "POST", "/api/session", { devSub: "me" })).status).toBe(401);
    const dev = w.api();
    dev.env = { ...dev.env, DEV_MODE: "1" };
    expect((await call(dev, "POST", "/api/session", { devSub: "me" })).status).toBe(200);
  });
});

describe("tools and materials", () => {
  const withItems = () => world([active({ plugins: ["tools"] })]);
  const qtyOf = async (w: ReturnType<typeof world>, name: string) =>
    (await w.deps.storageFor(active()).list("tools")).find((r) => r.name === name && r.removed !== "1")?.qty;

  it("parses a trailing count, keeping numbers that are part of the name", async () => {
    const { parseItem } = await import("../src/plugins/counter");
    expect(parseItem("線鋸 1")).toEqual({ name: "線鋸", qty: 1 });
    expect(parseItem("電動 線鋸 -2")).toEqual({ name: "電動 線鋸", qty: -2 });
    expect(parseItem("木料 2x4")).toEqual({ name: "木料 2x4" });
    expect(parseItem("線鋸")).toEqual({ name: "線鋸" });
  });

  it("adds, stacks repeats case-insensitively, subtracts, sets and removes", async () => {
    const w = withItems();
    await handleEvent(msg("/tool 線鋸 1"), w.deps);
    expect(textOf(w.replies[0]?.[0])).toBe("🔧 新增 Added：線鋸 × 1");
    await handleEvent(msg("/tool 線鋸 2"), w.deps);
    expect(textOf(w.replies[1]?.[0])).toBe("🔧 線鋸：1 → 3");
    await handleEvent(msg("/tool Saw"), w.deps); // no number = +1
    await handleEvent(msg("/tool saw"), w.deps);
    expect(await qtyOf(w, "Saw")).toBe("2");

    await handleEvent(msg("/tool 線鋸 -5"), w.deps);
    expect(textOf(w.replies[4]?.[0])).toContain("只剩 3");
    await handleEvent(msg("/tool set 線鋸 10"), w.deps);
    expect(await qtyOf(w, "線鋸")).toBe("10");

    await handleEvent(msg("/tool del 線鋸"), w.deps);
    expect(await qtyOf(w, "線鋸")).toBeUndefined();
    await handleEvent(msg("/tool 線鋸 1"), w.deps); // comes back on the same row, from 0
    const rows = await w.deps.storageFor(active()).list("tools");
    expect(rows.filter((r) => r.name === "線鋸")).toHaveLength(1);
    expect(await qtyOf(w, "線鋸")).toBe("1");
  });

  it("shows a card with −1/+1 buttons per item", async () => {
    const w = withItems();
    await handleEvent(msg("/tool 線鋸 3"), w.deps);
    await handleEvent(msg("/tool"), w.deps);
    const card = w.replies[1]?.[0] as { type: string; altText: string };
    expect(card.type).toBe("flex");
    expect(card.altText).toContain("線鋸 × 3");
    expect(JSON.stringify(card).match(/"text":"\/tool 線鋸 [+-]1"/g)).toEqual(['"text":"/tool 線鋸 -1"', '"text":"/tool 線鋸 +1"']);
  });
});

describe("quick replies", () => {
  it("ride on every reply, translations included, so the buttons stay in reach", async () => {
    const w = world([active({ plugins: ["translate", "tasks", "tools", "materials"] })]);
    const spy = vi.spyOn(engines, "google").mockResolvedValue({ text: "Good morning" });
    await handleEvent(msg("大家早安"), w.deps);
    const reply = w.replies[0]?.[0] as { quickReply: { items: { action: { text: string } }[] } };
    expect(reply.quickReply.items.map((i) => i.action.text)).toEqual(["/translate", "/todo", "/tool", "/material", "/menu", "/template", "/help"]);
    spy.mockRestore();
  });
});

describe("reports", () => {
  it("/report replies with a summary and a signed link that serves the page and CSVs", async () => {
    const { handleReport } = await import("../src/report");
    const w = world([active({ name: "工班", plugins: ["tasks", "tools", "materials"] })]);
    await handleEvent(msg("/add 買早餐 @JOJO 1/2"), w.deps); // long overdue
    await handleEvent(msg("/add 載木料"), w.deps);
    await handleEvent(msg("/task done 2 已載到工地"), w.deps);
    await handleEvent(msg("/tool 線鋸 3"), w.deps);
    await handleEvent(msg('/material =SUM(A1) 1'), w.deps);

    await handleEvent(msg("/report"), w.deps);
    const tpl = w.replies[5]?.[0] as { altText: string; template: { actions: { uri: string }[] } };
    expect(tpl.altText).toContain("任務 2：完成 1、進行中 0、未開始 1、⚠️ 逾期 1");
    expect(tpl.altText).toContain("🔧 工具 1 項，共 3 件");
    expect(tpl.altText).toContain("🧱 材料 1 項，共 1 件");
    const url = new URL(tpl.template.actions[0]!.uri);
    expect(url.origin).toBe("https://bot.example");
    expect(url.searchParams.get("openExternalBrowser")).toBe("1");

    const load = async () => ({ group: (await w.repo.get("Cg"))!, storage: w.deps.storageFor(active()) });
    const page = (await handleReport(url.pathname, SECRET, load))!;
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("買早餐");
    expect(html).toContain('class="late"');

    const bytes = new Uint8Array(await (await handleReport(url.pathname + "/tasks.csv", SECRET, load))!.arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]); // UTF-8 BOM, so Excel reads Chinese
    const csv = new TextDecoder().decode(bytes);
    expect(csv.startsWith("編號,標題,翻譯,狀態,負責人,期限")).toBe(true);
    expect(csv).toContain("1,買早餐,,未開始,JOJO,1/2"); // tasks-only group: no translations
    const tools = await (await handleReport(url.pathname + "/tools.csv", SECRET, load))!;
    expect(tools.headers.get("Content-Disposition")).toMatch(/attachment; filename="tools-\d{4}-\d{2}-\d{2}\.csv"/);
    expect(await tools.text()).toContain("線鋸,,3");
    const materials = await (await handleReport(url.pathname + "/materials.csv", SECRET, load))!;
    expect(await materials.text()).toContain("'=SUM(A1),,1"); // formula injection neutralised
    expect(html).toContain("🔧 工具 Tools");
    expect(html).toContain("🧱 材料 Materials");
    expect((await handleReport(url.pathname + "/items.csv", SECRET, load))).toBeUndefined();

    expect((await handleReport(url.pathname, "other-secret", load))!.status).toBe(410);
    expect(await handleReport("/elsewhere", SECRET, load)).toBeUndefined();
  });

  it("reads due dates with or without a year, in Taipei time", async () => {
    const { dueDate } = await import("../src/report");
    const now = new Date("2026-10-16T04:00:00Z");
    expect(dueDate("10/16", now)!.toISOString()).toBe("2026-10-16T15:59:59.999Z");
    expect(dueDate("2027-1-5", now)!.toISOString()).toBe("2027-01-05T15:59:59.999Z");
    expect(dueDate("明天", now)).toBeUndefined();
  });
});

describe("help and templates", () => {
  it("/help explains the buttons and templates, then one section per active feature", async () => {
    const w = world([active({ plugins: ["translate", "tools"] })]);
    await handleEvent(msg("/help"), w.deps);
    const help = textOf(w.replies[0]?.[0]);
    expect(help).toContain("點輸入框上方的按鈕");
    expect(help).toContain("/template");
    expect(help).toContain("🌐 翻譯 Translate");
    expect(help).toContain("・/tool 線鋸 1　新增，或在原數量上加 1");
    expect(help).not.toContain("📋 任務 Tasks"); // tasks is off in this group
  });

  it("/template sends a card with a copy button per template, filtered by feature", async () => {
    const w = world([active({ plugins: ["translate", "tasks", "tools", "materials"] })]);
    await handleEvent(msg("/template"), w.deps);
    const card = JSON.stringify(w.replies[0]?.[0]);
    expect(card).toContain('"type":"clipboard"');
    expect(card).toContain('"clipboardText":"/add 工作內容 @負責人 10/20"');
    expect(card).toContain('"clipboardText":"/tool 工具名稱 1"');

    await handleEvent(msg("/template material"), w.deps);
    const items = JSON.stringify(w.replies[1]?.[0]);
    expect(items).toContain("/material set 材料名稱 5");
    expect(items).not.toContain('"clipboardText":"/tool');
    expect(items).not.toContain("/add 工作內容");
  });

  it("falls back to plain copyable messages when LINE rejects the card", async () => {
    const w = world([active({ plugins: ["tasks"] })]);
    const reply = w.deps.line.reply;
    let first = true;
    w.deps.line.reply = async (t, m) => {
      if (first) {
        first = false;
        throw new Error("LINE API /message/reply failed: 400");
      }
      return reply(t, m);
    };
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await handleEvent(msg("/template"), w.deps);
    expect(w.replies[0]?.map(textOf)).toEqual(["長按下面的訊息 → 複製 → 貼上修改後送出", "/add 工作內容 @負責人 10/20", "/task done 任務編號 現況說明", "/task fail 任務編號 原因", "/task assign 任務編號 名字"]);
    err.mockRestore();
  });
});

describe("translated tasks and items", () => {
  const pro = () =>
    world([active({ plan: "pro", plugins: ["translate", "tasks", "tools", "materials"], settings: { translate: { engine: "google", languages: ["zh-TW", "en", "vi"] } } })]);
  const fake = (dict: Record<string, Record<string, string>>) =>
    vi.spyOn(engines, "google").mockImplementation(async (t, target) => ({ text: dict[t]?.[target] ?? t }));

  it("translates new task titles and shows them in replies, the card and the report", async () => {
    const w = pro();
    const spy = fake({ 買早餐: { en: "Buy breakfast", vi: "Mua bữa sáng" } });
    await handleEvent(msg("/add 買早餐 @JOJO 10/17"), w.deps);
    expect(textOf(w.replies[0]?.[0])).toContain("#1 買早餐 / Buy breakfast / Mua bữa sáng");
    await handleEvent(msg("/todo"), w.deps);
    expect(JSON.stringify(w.replies[1]?.[0])).toContain("🇺🇸 Buy breakfast  🇻🇳 Mua bữa sáng");
    const { tasksCsv, buildReport } = await import("../src/report");
    const csv = tasksCsv(await buildReport((await w.repo.get("Cg"))!, w.deps.storageFor(active())));
    expect(csv).toContain("買早餐,Buy breakfast / Mua bữa sáng,");
    expect(await w.usage.get("Cg", "translate_chars")).toBe(6); // 3 chars × 2 languages
    spy.mockRestore();
  });

  it("stacks an item typed in another language onto the same row", async () => {
    const w = pro();
    const spy = fake({ 線鋸: { en: "Jigsaw", vi: "Cưa lọng" } });
    await handleEvent(msg("/tool 線鋸 2"), w.deps);
    expect(textOf(w.replies[0]?.[0])).toBe("🔧 新增 Added：線鋸 / Jigsaw / Cưa lọng × 2");
    await handleEvent(msg("/tool jigsaw 1"), w.deps);
    expect(textOf(w.replies[1]?.[0])).toBe("🔧 線鋸 / Jigsaw / Cưa lọng：2 → 3");
    const rows = await w.deps.storageFor(active()).list("tools");
    expect(rows).toHaveLength(1);
    spy.mockRestore();
  });

  it("back-fills old rows when listed, and does not retry names that stay the same", async () => {
    const w = pro();
    const db = w.deps.storageFor(active());
    await db.append("tasks", { title: "Zace 載木料", status: "未開始" });
    await db.append("tools", { name: "Zace", qty: "1" });
    const spy = fake({ "Zace 載木料": { en: "Zace hauls timber", vi: "Zace chở gỗ" } }); // "Zace" comes back unchanged
    await handleEvent(msg("/todo"), w.deps);
    expect(JSON.stringify(w.replies[0]?.[0])).toContain("🇺🇸 Zace hauls timber");
    await handleEvent(msg("/tool"), w.deps);
    const calls = spy.mock.calls.length;
    await handleEvent(msg("/tool"), w.deps); // Zace is remembered as untranslatable
    await handleEvent(msg("/todo"), w.deps);
    expect(spy.mock.calls.length).toBe(calls);
    spy.mockRestore();
  });

  it("leaves labels untranslated when the group has translation off", async () => {
    const w = world([active({ plugins: ["tasks"] })]);
    const spy = vi.spyOn(engines, "google");
    await handleEvent(msg("/add 買早餐"), w.deps);
    expect(spy).not.toHaveBeenCalled();
    expect(textOf(w.replies[0]?.[0])).toContain("#1 買早餐 [未開始]");
    spy.mockRestore();
  });
});

describe("tools vs materials", () => {
  it("keeps separate lists, and points the old /item command to the new ones", async () => {
    const w = world([active({ plugins: ["tools", "materials"] })]);
    await handleEvent(msg("/tool 線鋸 1"), w.deps);
    await handleEvent(msg("/material 螺絲 100"), w.deps);
    await handleEvent(msg("/mat 螺絲 -20"), w.deps);
    expect(textOf(w.replies[2]?.[0])).toBe("🧱 螺絲：100 → 80");
    const db = w.deps.storageFor(active());
    expect((await db.list("tools")).map((r) => r.name)).toEqual(["線鋸"]);
    expect((await db.list("materials")).map((r) => [r.name, r.qty])).toEqual([["螺絲", "80"]]);

    await handleEvent(msg("/material"), w.deps);
    expect(JSON.stringify(w.replies[3]?.[0])).toContain('"text":"/material 螺絲 +1"');
    await handleEvent(msg("/item 線鋸 1"), w.deps);
    expect(textOf(w.replies[4]?.[0])).toContain("/tool 工具");
    expect(await db.list("items")).toEqual([]);
  });
});

describe("failed tasks", () => {
  it("can be failed with a reason, leave /todo, and be started again", async () => {
    const w = world([active({ plugins: ["tasks"] })]);
    await handleEvent(msg("/add 搭鷹架 10/20"), w.deps);
    await handleEvent(msg("/add 買螺絲"), w.deps);
    await handleEvent(msg("/task fail 1 下雨延期"), w.deps);
    const failed = w.replies[2]?.[0] as { text: string; quickReply: { items: { action: { text: string } }[] } };
    expect(failed.text).toBe("❌ #1 搭鷹架 [失敗] 👤Joseph ⏰10/20 （下雨延期）");
    expect(failed.quickReply.items[0]!.action.text).toBe("/task start 1");

    await handleEvent(msg("/todo"), w.deps);
    const card = w.replies[3]?.[0] as { altText: string };
    expect(card.altText).not.toContain("搭鷹架");
    expect(JSON.stringify(card)).toContain('"text":"/task fail 2"');

    await handleEvent(msg("/task start 1"), w.deps);
    expect(textOf(w.replies[4]?.[0])).toBe("▶️ #1 搭鷹架 [進行中] 👤Joseph ⏰10/20");
    const row = (await w.deps.storageFor(active()).list("tasks")).find((r) => r.id === "1");
    expect(row?.failReason).toBe("");
  });

  it("are counted and explained in the report", async () => {
    const w = world([active({ plugins: ["tasks"] })]);
    await handleEvent(msg("/add 搭鷹架 1/2"), w.deps); // overdue, but failed tasks are not "overdue"
    await handleEvent(msg("/add 買螺絲"), w.deps);
    await handleEvent(msg("/task fail 1 下雨延期"), w.deps);
    const { buildReport, summaryText, tasksCsv, reportHtml } = await import("../src/report");
    const data = await buildReport((await w.repo.get("Cg"))!, w.deps.storageFor(active()));
    expect(data.summary).toMatchObject({ total: 2, done: 0, failed: 1, doing: 0, todo: 1, overdue: 0 });
    expect(summaryText(data)).toContain("任務 2：完成 0、失敗 1、進行中 0、未開始 1");
    const csv = tasksCsv(data);
    expect(csv).toContain("失敗原因,結束時間");
    expect(csv).toMatch(/1,搭鷹架,,失敗,Joseph,1\/2,Joseph,[^,]*,下雨延期,\d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
    expect(reportHtml(data, "t")).toContain('<tr class="failed">');
  });
});

describe("menu and always-on quick replies", () => {
  it("/menu is a card of buttons for every active feature, usable on LINE for PC", async () => {
    const w = world([active({ plugins: ["translate", "tasks", "tools", "materials"] })]);
    await handleEvent(msg("/menu"), w.deps);
    const card = w.replies[0]?.[0] as { type: string };
    expect(card.type).toBe("flex");
    const sends = JSON.stringify(card).match(/"type":"message","label":"[^"]+","text":"([^"]+)"/g)!.map((s) => s.replace(/.*"text":"/, "").replace(/"$/, ""));
    expect(sends.slice(0, 8)).toEqual(["/translate", "/todo", "/tool", "/material", "/report", "/template", "/settings", "/help"]);
  });

  it("rides on /report, /settings and /admin replies too", async () => {
    const w = world([active({ plugins: ["tasks"] })]);
    for (const c of ["/report", "/settings", "/admin"]) await handleEvent(msg(c), w.deps);
    for (const r of w.replies) expect((r.at(-1) as { quickReply?: unknown }).quickReply).toBeTruthy();
  });
});

describe("/task assign", () => {
  it("drops the @ of a mention, like /add", async () => {
    const w = world([active({ plugins: ["tasks"] })]);
    await handleEvent(msg("/add 搭鷹架"), w.deps);
    await handleEvent(msg("/task assign 1 @繪文"), w.deps);
    expect(textOf(w.replies[1]?.[0])).toBe("👤 #1 搭鷹架 [未開始] 👤繪文");
  });
});

describe("done needs a report", () => {
  it("tapping Done waits for the member's next message and stores it as the report", async () => {
    const w = world([active({ plugins: ["tasks"] })]);
    await handleEvent(msg("/add 去租工具"), w.deps);
    await handleEvent(msg("/task done 1"), w.deps); // what the card button sends
    expect(textOf(w.replies[1]?.[0])).toContain("請 Joseph 直接回覆一則訊息");
    await handleEvent(msg("/todo"), w.deps); // still open until reported
    expect((w.replies[2]?.[0] as { altText: string }).altText).toContain("去租工具");

    await handleEvent(msg("今天天氣好", "U2"), w.deps); // someone else talking is not the report
    await handleEvent(msg("租到 2 台線鋸，週五下午可以取"), w.deps);
    expect(textOf(w.replies.at(-1)?.[0])).toBe("✅ #1 去租工具 [完成] 👤Joseph\n📝 回報 Report：租到 2 台線鋸，週五下午可以取");
    const row = (await w.deps.storageFor(active()).list("tasks"))[0]!;
    expect(row).toMatchObject({ status: "完成", report: "租到 2 台線鋸，週五下午可以取", reportBy: "" });

    const count = w.replies.length;
    await handleEvent(msg("謝謝大家"), w.deps); // the wait is over: an ordinary message again
    expect(w.replies.length).toBe(count);
  });

  it("completes in one go with /task done <id> <report>, and ignores late replies", async () => {
    const w = world([active({ plugins: ["tasks"] })]);
    await handleEvent(msg("/add 去租工具"), w.deps);
    await handleEvent(msg("/task done 1 租到 2 台，週五可取"), w.deps);
    expect(textOf(w.replies[1]?.[0])).toContain("📝 回報 Report：租到 2 台，週五可取");

    await handleEvent(msg("/add 買螺絲"), w.deps);
    await handleEvent(msg("/task done 2"), w.deps);
    const late = { ...msg("買到了"), timestamp: Date.now() + 11 * 60 * 1000 }; // after the 10-minute window
    await handleEvent(late, w.deps);
    const row = (await w.deps.storageFor(active()).list("tasks")).find((r) => r.id === "2")!;
    expect(row.status).toBe("未開始");
  });

  it("shows the report in the report page and CSV", async () => {
    const w = world([active({ plugins: ["tasks"] })]);
    await handleEvent(msg("/add 去租工具"), w.deps);
    await handleEvent(msg("/task done 1 租到 2 台"), w.deps);
    const { buildReport, tasksCsv } = await import("../src/report");
    const csv = tasksCsv(await buildReport((await w.repo.get("Cg"))!, w.deps.storageFor(active())));
    expect(csv).toContain("完成回報／失敗原因");
    expect(csv).toContain(",租到 2 台,");
  });
});

describe("one-time activation codes", () => {
  const join = (groupId: string): LineEvent => ({ type: "join", replyToken: "r", timestamp: 0, source: { type: "group", groupId } });

  it("work once, and start the group on the plan they carry", async () => {
    const w = world();
    const pro = await w.codes.create({ label: "王師傅", channelId: "default", plan: "pro", planUntil: "2099-12-31" });
    await handleEvent(join("Ca"), w.deps);
    await handleEvent(msg(`/activate ${pro.code.slice(0, 4)}-${pro.code.slice(4, 8)}-${pro.code.slice(8)}`, "U1", "Ca"), w.deps);
    expect(textOf(w.replies[1]?.[0])).toContain("💎 方案 Plan：專業版 Pro（到 2099-12-31）");
    expect(await w.repo.get("Ca")).toMatchObject({ status: "active", plan: "pro", planUntil: "2099-12-31" });
    expect(await w.admins.get("Ca", "U1")).toMatchObject({ role: "owner" });

    await handleEvent(join("Cb"), w.deps);
    await handleEvent(msg(`/activate ${pro.code}`, "U2", "Cb"), w.deps);
    expect(textOf(w.replies[3]?.[0])).toContain("已使用或已過期");
    expect((await w.repo.get("Cb"))?.status).toBe("pending");
  });

  it("are issued, listed and revoked by platform admins", async () => {
    const w = world([active({ name: "工班" })]);
    const api = w.api();
    const call = async (method: string, path: string, body?: unknown, session?: string) => {
      const res = await handleApi(
        new Request("https://bot.example" + path, {
          method,
          headers: { "Content-Type": "application/json", ...(session ? { Authorization: "Bearer " + session } : {}) },
          body: body === undefined ? undefined : JSON.stringify(body),
        }),
        api,
      );
      return { status: res.status, data: (await res.json()) as any };
    };
    const boss = (await call("POST", "/api/session", { idToken: "ok:boss" })).data.session as string;
    const other = (await call("POST", "/api/session", { idToken: "ok:someone" })).data.session as string;
    expect((await call("POST", "/api/admin/codes", {}, other)).status).toBe(403);

    const made = await call("POST", "/api/admin/codes", { label: "王師傅", plan: "pro", planUntil: "2099-12-31", validDays: 30, count: 2 }, boss);
    expect(made.data).toHaveLength(2);
    expect(made.data[0].code).toMatch(/^[2-9A-Z]{4}-[2-9A-Z]{4}-[2-9A-Z]{4}$/);
    expect((await call("POST", "/api/admin/codes", { count: 21 }, boss)).status).toBe(400);
    expect((await call("POST", "/api/admin/codes", { channelId: "nope" }, boss)).status).toBe(400);

    await handleEvent(msg(`/activate ${made.data[0].code}`, "U1", "Cg"), w.deps); // claims Cg
    const list = (await call("GET", "/api/admin/codes", undefined, boss)).data as { code: string; status: string; usedGroup?: string }[];
    expect(list.find((c) => c.code === made.data[0].code)).toMatchObject({ status: "used", usedGroup: "工班" });
    expect(list.find((c) => c.code === made.data[1].code)).toMatchObject({ status: "unused" });

    expect((await call("DELETE", `/api/admin/codes/${made.data[0].code}`, undefined, boss)).status).toBe(400);
    expect((await call("DELETE", `/api/admin/codes/${made.data[1].code}`, undefined, boss)).status).toBe(200);
  });
});
