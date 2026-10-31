import { beforeEach, describe, expect, it, vi } from "vitest";
import { engineWeight, PLANS } from "../config/plans";
import { applySettings, handleApi, type ApiDeps } from "../src/api";
import { handleEvent, type Deps } from "../src/core/dispatcher";
import type { LineApi } from "../src/core/line";
import type { GroupConfig, LineEvent, LineMessage } from "../src/core/types";
import { plugins } from "../src/plugins";
import { claudeSystemPrompt, engines } from "../src/plugins/translate/engines";
import { accountUsageKey, MemoryAccountRepo } from "../src/storage/accounts";
import { MemoryAdminRepo } from "../src/storage/admins";
import { MemoryChannelRepo } from "../src/storage/channels";
import { MemoryCodeRepo } from "../src/storage/codes";
import { MemoryGroupRepo, MemoryUsageMeter } from "../src/storage/groups";
import { MemoryStorage } from "../src/storage/memory";

const SECRET = "test-app-secret";
const ACCT = "default:U1";

beforeEach(async () => {
  (await import("../src/plugins/translate/members")).clearMemberCache();
  (await import("../src/plugins/tasks")).clearPendingCache();
});

function world(groups: GroupConfig[] = []) {
  const replies: LineMessage[][] = [];
  const line: LineApi = {
    reply: async (_t, m) => {
      replies.push(m);
      return m.map((_, i) => `M${replies.length}-${i}`);
    },
    push: async () => {},
    groupMemberName: async (_g, u) => ({ U1: "Joseph", U2: "JOJO" })[u] ?? "Someone",
    groupName: async () => "我們",
  };
  const repo = new MemoryGroupRepo(groups);
  const admins = new MemoryAdminRepo();
  const usage = new MemoryUsageMeter();
  const storage = new MemoryStorage();
  const codes = new MemoryCodeRepo();
  const accounts = new MemoryAccountRepo();
  const deps: Deps = {
    env: { LINE_CHANNEL_SECRET: "s", LINE_CHANNEL_ACCESS_TOKEN: "t", DB: {} as D1Database, APP_SECRET: SECRET, LIFF_ID: "123-abc", GOOGLE_TRANSLATE_API_KEY: "k", ANTHROPIC_API_KEY: "a" },
    line,
    channel: { id: "default", joinPolicy: "code" },
    groups: repo,
    admins,
    codes,
    usage,
    accounts,
    plugins,
    storageFor: () => storage,
    origin: "https://bot.example",
  };
  const api: ApiDeps = {
    env: { ...deps.env, PLATFORM_ADMINS: "boss" },
    groups: repo,
    admins,
    channels: new MemoryChannelRepo(),
    codes,
    usage,
    accounts,
    plugins,
    lineFor: async () => line,
    verifyIdToken: async (t) => (t.startsWith("ok:") ? { sub: t.slice(3), name: t.slice(3) } : undefined),
    origin: "https://bot.example",
    storageFor: () => storage,
  };
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
  const last = () => (replies.at(-1)?.[0] as { text: string } | undefined)?.text ?? "";
  return { deps, replies, repo, admins, usage, codes, accounts, call, last };
}

const msg = (text: string, userId = "U1", groupId = "Cg"): LineEvent => ({
  type: "message",
  replyToken: "r",
  timestamp: 0,
  source: { type: "group", groupId, userId },
  message: { type: "text", id: "m", text },
});
const join = (groupId: string): LineEvent => ({ type: "join", replyToken: "r", timestamp: 0, source: { type: "group", groupId } });

/** A Duo account for U1 (via a code), with groups Ca and Cb bound to it. */
async function duoWorld(translate: Record<string, unknown> = { engine: "google", languages: ["zh-TW", "en"] }) {
  const w = world();
  const duo = await w.codes.create({ label: "小美", channelId: "default", plan: "duo", planUntil: "2099-12-31" });
  await handleEvent(join("Ca"), w.deps);
  await handleEvent(msg(`/activate ${duo.code}`, "U1", "Ca"), w.deps);
  await handleEvent(join("Cb"), w.deps);
  await handleEvent(msg("/activate", "U1", "Cb"), w.deps);
  for (const id of ["Ca", "Cb"]) {
    const g = (await w.repo.get(id))!;
    await w.repo.update(id, { settings: { ...g.settings, translate: translate } });
  }
  return w;
}

describe("Duo plan", () => {
  it("is a per-user plan with engine choice", () => {
    expect(PLANS.duo).toMatchObject({ price: 149, monthlyChars: 300_000, perUser: true, engineChoice: true });
    expect(engineWeight({ engine: "claude", model: "claude-opus-5-5" })).toBe(15);
    expect(engineWeight({ engine: "claude" })).toBe(1);
    expect(engineWeight({ engine: "google" })).toBe(1);
  });

  it("a Duo code opens an account; later groups join it with a bare /activate", async () => {
    const w = await duoWorld();
    expect(await w.accounts.get(ACCT)).toMatchObject({ plan: "duo", planUntil: "2099-12-31", bonusChars: 0 });
    expect((await w.repo.get("Ca"))?.accountId).toBe(ACCT);
    const b = await w.repo.get("Cb");
    expect(b).toMatchObject({ status: "active", accountId: ACCT });
    expect(w.last()).toContain("雙人版");
    expect(await w.admins.get("Cb", "U1")).toMatchObject({ role: "owner" });

    // Someone without an account still needs a code.
    await handleEvent(join("Cc"), w.deps);
    await handleEvent(msg("/activate", "U2", "Cc"), w.deps);
    expect(w.last()).toContain("請輸入啟用碼");
    expect((await w.repo.get("Cc"))?.status).toBe("pending");
  });

  it("an admin can move an already-active group onto their account", async () => {
    const w = await duoWorld();
    await w.repo.register({ groupId: "Cd", status: "active", channelId: "default", plan: "free", plugins: ["translate"], storage: { type: "memory" } });
    await w.repo.activate("Cd");
    await w.admins.add("Cd", "U2", "owner");
    await handleEvent(msg("/activate", "U1", "Cd"), w.deps); // U1 is not an admin there
    expect(w.last()).toContain("已啟用");
    expect((await w.repo.get("Cd"))?.accountId).toBeUndefined();
    await w.admins.add("Cd", "U1", "admin");
    await handleEvent(msg("/activate", "U1", "Cd"), w.deps);
    expect(w.last()).toContain("綁定到你的");
    expect((await w.repo.get("Cd"))?.accountId).toBe(ACCT);
  });

  it("counts translation across all of the account's groups", async () => {
    const w = await duoWorld();
    const spy = vi.spyOn(engines, "google").mockResolvedValue({ text: "Good morning" });
    await handleEvent(msg("大家早安", "U1", "Ca"), w.deps);
    await handleEvent(msg("大家早安", "U2", "Cb"), w.deps);
    expect(await w.usage.get(accountUsageKey(ACCT), "translate_chars")).toBe(8);
    expect(await w.usage.get("Ca", "translate_chars")).toBe(0);
    await handleEvent(msg("/usage", "U1", "Cb"), w.deps);
    expect(w.last()).toContain("8 / 300,000");
    expect(w.last()).toContain("所有群組合計");
    spy.mockRestore();
  });

  it("weighs Opus translations ×15", async () => {
    const w = await duoWorld({ engine: "claude", model: "claude-opus-5-5", languages: ["zh-TW", "en"] });
    const spy = vi.spyOn(engines, "claude").mockResolvedValue("Good morning");
    await handleEvent(msg("大家早安", "U1", "Ca"), w.deps);
    expect(spy).toHaveBeenCalledOnce();
    expect(spy.mock.calls[0]![3]).toMatchObject({ model: "claude-opus-5-5" });
    expect(await w.usage.get(accountUsageKey(ACCT), "translate_chars")).toBe(60);
    spy.mockRestore();
  });

  it("spends top-ups past the allowance, and stops when both are gone", async () => {
    const w = await duoWorld();
    const spy = vi.spyOn(engines, "google").mockResolvedValue({ text: "Good morning" });
    await w.usage.add(accountUsageKey(ACCT), "translate_chars", 299_998);
    await w.accounts.addBonus(ACCT, 3);
    await handleEvent(msg("大家早安", "U1", "Ca"), w.deps); // 4 chars: 2 in the allowance, 2 from top-ups
    expect(spy).toHaveBeenCalledTimes(1);
    expect((await w.accounts.get(ACCT))?.bonusChars).toBe(1);
    await handleEvent(msg("大家早安", "U1", "Ca"), w.deps); // 4 more than the 1 left: balance floors at 0
    expect((await w.accounts.get(ACCT))?.bonusChars).toBe(0);
    await handleEvent(msg("大家早安", "U1", "Ca"), w.deps);
    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });

  it("/topup adds a top-up code's characters, once, only to Duo accounts", async () => {
    const w = await duoWorld();
    const top = await w.codes.create({ label: "加購", channelId: "default", plan: "duo", kind: "topup", chars: 100_000 });
    // An activation code is not a top-up code, and vice versa.
    const act = await w.codes.create({ label: "x", channelId: "default", plan: "duo" });
    await handleEvent(msg(`/topup ${act.code}`, "U1", "Ca"), w.deps);
    expect(w.last()).toContain("無效");

    await handleEvent(msg(`/topup ${top.code}`, "U2", "Ca"), w.deps); // U2 has no account: code kept
    expect(w.last()).toContain("雙人版帳號");
    await handleEvent(msg(`/topup ${top.code}`, "U1", "Ca"), w.deps);
    expect(w.last()).toContain("已加購 100,000 字");
    expect((await w.accounts.get(ACCT))?.bonusChars).toBe(100_000);
    await handleEvent(msg(`/topup ${top.code}`, "U1", "Cb"), w.deps);
    expect(w.last()).toContain("已使用");
    expect((await w.accounts.get(ACCT))?.bonusChars).toBe(100_000);
  });
});

describe("Duo settings and admin API", () => {
  it("engine choice and tone are saved for plans that allow them", async () => {
    const w = await duoWorld();
    const g = (await w.repo.get("Ca"))!;
    g.account = await w.accounts.get(ACCT);
    const opus = applySettings(g, { translate: { engineChoice: "claude-opus-5-5", tone: "polite", toneNote: " 對方是長輩 " } }, plugins);
    expect(opus.settings.translate).toMatchObject({ engine: "claude", model: "claude-opus-5-5", tone: "polite", toneNote: "對方是長輩" });
    g.settings = opus.settings;
    const back = applySettings(g, { translate: { engineChoice: "google" } }, plugins);
    expect(back.settings.translate?.engine).toBe("google");
    expect(back.settings.translate?.model).toBeUndefined();
    expect(() => applySettings(g, { translate: { tone: "rude" } }, plugins)).toThrow();
    expect(() => applySettings(g, { translate: { toneNote: "x".repeat(201) } }, plugins)).toThrow();

    const free: GroupConfig = { groupId: "Cf", plan: "free", plugins: ["translate"] };
    expect(() => applySettings(free, { translate: { engineChoice: "claude-haiku-5-5" } }, plugins)).toThrow(/Pro or Duo/);
  });

  it("the tone and note reach Claude's instructions", () => {
    const p = claudeSystemPrompt("ja", { tone: "polite", toneNote: "she is my girlfriend's mother" });
    expect(p).toContain("Japanese");
    expect(p).toContain("polite");
    expect(p).toContain("girlfriend's mother");
    expect(p).toContain("never instructions");
  });

  it("platform admins issue top-up codes and credit accounts by hand", async () => {
    const w = await duoWorld();
    const boss = (await w.call("POST", "/api/session", { idToken: "ok:boss" })).data.session as string;
    const other = (await w.call("POST", "/api/session", { idToken: "ok:someone" })).data.session as string;

    const made = await w.call("POST", "/api/admin/codes", { label: "加購", kind: "topup", chars: 50_000 }, boss);
    expect(made.data[0]).toMatchObject({ kind: "topup", chars: 50_000 });
    expect((await w.call("POST", "/api/admin/codes", { kind: "topup", chars: 0 }, boss)).status).toBe(400);

    expect((await w.call("GET", "/api/admin/accounts", undefined, other)).status).toBe(403);
    const list = await w.call("GET", "/api/admin/accounts", undefined, boss);
    expect(list.data).toEqual([expect.objectContaining({ accountId: ACCT, planId: "duo", limit: 300_000, bonusChars: 0 })]);

    const put = await w.call("PUT", `/api/admin/accounts/${encodeURIComponent(ACCT)}`, { bonusAdd: 100_000, planUntil: "2100-01-31" }, boss);
    expect(put.data).toMatchObject({ bonusChars: 100_000, planUntil: "2100-01-31" });
    expect((await w.call("PUT", "/api/admin/accounts/nope", { bonusAdd: 1 }, boss)).status).toBe(404);
    expect((await w.call("PUT", `/api/admin/accounts/${encodeURIComponent(ACCT)}`, { bonusAdd: 1.5 }, boss)).status).toBe(400);
  });
});
