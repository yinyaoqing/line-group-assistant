import { beforeEach, describe, expect, it, vi } from "vitest";
import { effectivePlan, engineWeight, mergeGrant, PLANS } from "../config/plans";
import { applySettings, handleApi, type ApiDeps } from "../src/api";
import { handleEvent, handleSchedule, type Deps } from "../src/core/dispatcher";
import type { LineApi } from "../src/core/line";
import type { GroupConfig, LineEvent, LineMessage } from "../src/core/types";
import { plugins } from "../src/plugins";
import { claudeSystemPrompt, cleanTranslation, engines } from "../src/plugins/translate/engines";
import { accountUsageKey, MemoryAccountRepo } from "../src/storage/accounts";
import { MemoryAdminRepo } from "../src/storage/admins";
import { MemoryChannelRepo } from "../src/storage/channels";
import { MemoryCodeRepo } from "../src/storage/codes";
import { MemoryGroupRepo, MemoryUsageMeter } from "../src/storage/groups";
import { MemoryStorage } from "../src/storage/memory";
import { MemoryOutboxRepo } from "../src/storage/outbox";

const SECRET = "test-app-secret";
const A1 = "default:U1";
const A2 = "default:U2";
const HAIKU = { engine: "claude", model: "claude-haiku-5-5", languages: ["zh-TW", "en"] };

beforeEach(async () => {
  (await import("../src/plugins/translate/members")).clearMemberCache();
  (await import("../src/plugins/tasks")).clearPendingCache();
});

function world() {
  const replies: LineMessage[][] = [];
  const pushes: LineMessage[][] = [];
  const line: LineApi = {
    reply: async (_t, m) => {
      replies.push(m);
      return m.map((_, i) => `M${replies.length}-${i}`);
    },
    push: async (_to, m) => void pushes.push(m),
    groupMemberName: async (_g, u) => ({ U1: "Joseph", U2: "JOJO" })[u] ?? "Someone",
    groupName: async () => "工班",
  };
  const repo = new MemoryGroupRepo([]);
  const admins = new MemoryAdminRepo();
  const usage = new MemoryUsageMeter();
  const storage = new MemoryStorage();
  const codes = new MemoryCodeRepo();
  const accounts = new MemoryAccountRepo();
  const outbox = new MemoryOutboxRepo();
  const deps: Deps = {
    env: { LINE_CHANNEL_SECRET: "s", LINE_CHANNEL_ACCESS_TOKEN: "t", DB: {} as D1Database, APP_SECRET: SECRET, LIFF_ID: "123-abc", ANTHROPIC_API_KEY: "a" },
    line,
    channel: { id: "default" },
    groups: repo,
    admins,
    codes,
    usage,
    accounts,
    outbox,
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
  const code = (plan = "free", planUntil?: string) => codes.create({ label: "t", channelId: "default", plan, planUntil });
  return { deps, replies, pushes, repo, admins, usage, codes, accounts, outbox, call, last, code };
}

const msg = (text: string, userId = "U1", groupId = "Cg"): LineEvent => ({
  type: "message",
  replyToken: "r",
  timestamp: 0,
  source: { type: "group", groupId, userId },
  message: { type: "text", id: "m", text },
});
const mention = (text: string, userId = "U1", groupId = "Cg"): LineEvent => ({
  ...msg(`@通事 ${text}`, userId, groupId),
  message: { type: "text", id: "m", text: `@通事 ${text}`, mention: { mentionees: [{ index: 0, length: 3, isSelf: true }] } },
});
const join = (groupId: string): LineEvent => ({ type: "join", replyToken: "r", timestamp: 0, source: { type: "group", groupId } });

/** U1 on `plan` (via a code) with groups Ca and Cb bound to their account. */
async function paidWorld(plan = "starter", translate: Record<string, unknown> = HAIKU) {
  const w = world();
  const c = await w.code(plan, "2099-12-31");
  await handleEvent(join("Ca"), w.deps);
  await handleEvent(msg(`/activate ${c.code}`, "U1", "Ca"), w.deps);
  await handleEvent(join("Cb"), w.deps);
  await handleEvent(msg("/activate", "U1", "Cb"), w.deps);
  for (const id of ["Ca", "Cb"]) {
    const g = (await w.repo.get(id))!;
    await w.repo.update(id, { settings: { ...g.settings, translate } });
  }
  return w;
}

describe("plans", () => {
  it("are per person, priced and limited by usage only", () => {
    expect(PLANS.free).toMatchObject({ price: 0, monthlyChars: 30_000, ai: false, engineChoice: false, topUp: false });
    expect(PLANS.starter).toMatchObject({ price: 149, monthlyChars: 300_000, aiRequests: 100, engineChoice: true, topUp: false });
    expect(PLANS.advanced).toMatchObject({ price: 399, monthlyChars: 1_500_000, aiRequests: 500, topUp: true });
    // Weights follow what each engine really costs per character, relative to Haiku.
    expect(engineWeight({ engine: "claude", model: "claude-opus-5-5" })).toBe(15);
    expect(engineWeight({})).toBe(1);
    expect(engineWeight({ engine: "google" })).toBe(18);
  });

  it("read old plan names", () => {
    expect(effectivePlan("pro", "2099-12-31").id).toBe("advanced");
    expect(effectivePlan("duo", "2099-12-31").id).toBe("starter");
    expect(effectivePlan("nonsense", undefined).id).toBe("free");
  });

  it("never downgrade an account still on a better plan, and never shorten a renewal", () => {
    const now = new Date("2026-11-01T00:00:00Z");
    expect(mergeGrant({ plan: "advanced", planUntil: "2026-12-31" }, "starter", "2027-06-30", now)).toEqual({ plan: "advanced", planUntil: "2026-12-31" });
    expect(mergeGrant({ plan: "starter", planUntil: "2027-03-31" }, "starter", "2026-12-31", now)).toEqual({ plan: "starter", planUntil: "2027-03-31" });
    expect(mergeGrant({ plan: "starter", planUntil: "2026-12-31" }, "advanced", "2027-01-31", now)).toEqual({ plan: "advanced", planUntil: "2027-01-31" });
    // An expired plan no longer protects anything.
    expect(mergeGrant({ plan: "advanced", planUntil: "2026-01-31" }, "starter", "2027-01-31", now)).toEqual({ plan: "starter", planUntil: "2027-01-31" });
    expect(mergeGrant({ plan: "starter", planUntil: "2026-12-31" }, "free", undefined, now)).toEqual({ plan: "starter", planUntil: "2026-12-31" });
  });
});

describe("accounts and /activate", () => {
  it("every member who activates gets an account, and the group bills to it", async () => {
    const w = world();
    const c = await w.code();
    await handleEvent(join("Cg"), w.deps);
    await handleEvent(msg(`/activate ${c.code}`), w.deps);
    expect(await w.accounts.get(A1)).toMatchObject({ plan: "free" });
    expect(await w.repo.get("Cg")).toMatchObject({ status: "active", accountId: A1 });
    expect(w.last()).toContain("免費 Free");
    expect(await w.admins.get("Cg", "U1")).toMatchObject({ role: "owner" });
    // A free member still needs a code for the next group.
    await handleEvent(join("Ch"), w.deps);
    await handleEvent(msg("/activate", "U1", "Ch"), w.deps);
    expect(w.last()).toContain("請輸入啟用碼");
  });

  it("a paid code opens a paid account; the payer's later groups join it with a bare /activate", async () => {
    const w = await paidWorld();
    expect(await w.accounts.get(A1)).toMatchObject({ plan: "starter", planUntil: "2099-12-31" });
    expect(await w.repo.get("Cb")).toMatchObject({ status: "active", accountId: A1 });
    expect(w.last()).toContain("入門 Starter");
  });

  it("an admin on a paid plan can take an active group's billing over; others cannot", async () => {
    const w = await paidWorld();
    const c = await w.code();
    await handleEvent(join("Cd"), w.deps);
    await handleEvent(msg(`/activate ${c.code}`, "U2", "Cd"), w.deps);
    expect((await w.repo.get("Cd"))?.accountId).toBe(A2);
    await handleEvent(msg("/activate", "U1", "Cd"), w.deps); // U1 is not an admin there
    expect((await w.repo.get("Cd"))?.accountId).toBe(A2);
    await w.admins.add("Cd", "U1", "admin");
    await handleEvent(msg("/activate", "U1", "Cd"), w.deps);
    expect(w.last()).toContain("改算在你的");
    expect((await w.repo.get("Cd"))?.accountId).toBe(A1);
    // A free admin's bare /activate does not move it back.
    await handleEvent(msg("/activate", "U2", "Cd"), w.deps);
    expect((await w.repo.get("Cd"))?.accountId).toBe(A1);
  });

  it("a code redeemed in an active group upgrades the sender; a lower plan never takes the group from a higher one", async () => {
    const w = await paidWorld("advanced");
    await w.admins.add("Ca", "U2", "admin");
    const free = await w.code();
    await handleEvent(msg(`/activate ${free.code}`, "U2", "Ca"), w.deps);
    expect((await w.repo.get("Ca"))?.accountId).toBe(A1); // free < advanced: stays
    expect(await w.accounts.get(A2)).toMatchObject({ plan: "free" });
    const adv = await w.code("advanced", "2100-01-31");
    await handleEvent(msg(`/activate ${adv.code}`, "U2", "Ca"), w.deps);
    expect((await w.repo.get("Ca"))?.accountId).toBe(A2); // same plan: the admin who just paid takes it
  });

  it("counts translation across all of the account's groups", async () => {
    const w = await paidWorld();
    const spy = vi.spyOn(engines, "claude").mockResolvedValue("Good morning");
    await handleEvent(msg("大家早安", "U1", "Ca"), w.deps);
    await handleEvent(msg("大家早安", "U2", "Cb"), w.deps);
    expect(await w.usage.get(accountUsageKey(A1), "translate_chars")).toBe(8);
    expect(await w.usage.get("Ca", "translate_chars")).toBe(0);
    await handleEvent(msg("/usage", "U1", "Cb"), w.deps);
    expect(w.last()).toContain("8 / 300,000");
    expect(w.last()).toContain("所有群組合計");
    expect(w.last()).toContain("0 / 100 次");
    spy.mockRestore();
  });

  it("weighs Opus translations ×15", async () => {
    const w = await paidWorld("starter", { engine: "claude", model: "claude-opus-5-5", languages: ["zh-TW", "en"] });
    const spy = vi.spyOn(engines, "claude").mockResolvedValue("Good morning");
    await handleEvent(msg("大家早安", "U1", "Ca"), w.deps);
    expect(spy.mock.calls[0]![3]).toMatchObject({ model: "claude-opus-5-5" });
    expect(await w.usage.get(accountUsageKey(A1), "translate_chars")).toBe(60);
    spy.mockRestore();
  });

  it("checks a message's cost before translating it, then spends top-ups (Advanced) past the allowance", async () => {
    const w = await paidWorld("advanced");
    const spy = vi.spyOn(engines, "claude").mockResolvedValue("Good morning");
    await w.usage.add(accountUsageKey(A1), "translate_chars", 1_499_998);
    await handleEvent(msg("大家早安", "U1", "Ca"), w.deps); // costs 4, only 2 left: refused before any call
    expect(spy).not.toHaveBeenCalled();
    expect(w.last()).toContain("額度已用完");
    await w.accounts.addBonus(A1, 3);
    await handleEvent(msg("大家早安", "U1", "Cb"), w.deps); // 2 from the allowance, 2 from top-ups
    expect(spy).toHaveBeenCalledTimes(1);
    expect((await w.accounts.get(A1))?.bonusChars).toBe(1);
    spy.mockRestore();
  });

  it("/topup works only on Advanced accounts, once per code", async () => {
    const w = await paidWorld("starter");
    const top = await w.codes.create({ label: "加購", channelId: "default", plan: "free", kind: "topup", chars: 500_000 });
    await handleEvent(msg(`/topup ${top.code}`, "U1", "Ca"), w.deps);
    expect(w.last()).toContain("進階版");
    await w.accounts.update(A1, { plan: "advanced" });
    await handleEvent(msg(`/topup ${top.code}`, "U1", "Ca"), w.deps);
    expect(w.last()).toContain("已加購 500,000 字");
    await handleEvent(msg(`/topup ${top.code}`, "U1", "Cb"), w.deps);
    expect(w.last()).toContain("已使用");
    expect((await w.accounts.get(A1))?.bonusChars).toBe(500_000);
  });

  it("caps the AI assistant at the plan's monthly requests, across groups, before calling Claude", async () => {
    const free = world();
    const c = await free.code();
    await handleEvent(msg(`/activate ${c.code}`), free.deps);
    await handleEvent(mention("新增任務 買螺絲"), free.deps);
    expect(free.last()).toContain("付費方案功能");

    const w = await paidWorld("starter");
    await w.usage.add(accountUsageKey(A1), "ai_requests", 100);
    await handleEvent(mention("新增任務 買螺絲", "U1", "Cb"), w.deps);
    expect(w.last()).toContain("100 次已用完");
  });

  it("scheduled messages always wait for the next free reply, even if a group once chose push", async () => {
    const w = await paidWorld();
    const g = (await w.repo.get("Ca"))!;
    await w.repo.update("Ca", { settings: { ...g.settings, tasks: { digest: true }, core: { notify: "push" } } });
    const spy = vi.spyOn(engines, "claude").mockResolvedValue("Buy screws");
    await handleEvent(msg("/add 買螺絲", "U1", "Ca"), w.deps);
    spy.mockRestore();
    await handleSchedule("0 0 * * 1", w.deps, async () => w.deps.line);
    expect(w.pushes).toHaveLength(0);
    expect(await w.outbox.take("Ca", 5)).toHaveLength(1);
  });
});

describe("settings and admin API", () => {
  it("engine choice and tone are saved for paid plans; Google is no longer offered", async () => {
    const w = await paidWorld();
    const g = (await w.repo.get("Ca"))!;
    g.account = await w.accounts.get(A1);
    const opus = applySettings(g, { translate: { engineChoice: "claude-opus-5-5", tone: "polite", toneNote: " 對方是長輩 " } }, plugins);
    expect(opus.settings.translate).toMatchObject({ engine: "claude", model: "claude-opus-5-5", tone: "polite", toneNote: "對方是長輩" });
    expect(() => applySettings(g, { translate: { engineChoice: "google" } }, plugins)).toThrow();
    expect(() => applySettings(g, { translate: { tone: "rude" } }, plugins)).toThrow();
    const free: GroupConfig = { groupId: "Cf", plan: "free", plugins: ["translate"] };
    expect(() => applySettings(free, { translate: { engineChoice: "claude-haiku-5-5" } }, plugins)).toThrow(/paid plan/);
  });

  it("the tone and note reach Claude's instructions", () => {
    const p = claudeSystemPrompt("ja", { tone: "polite", toneNote: "she is my girlfriend's mother" });
    expect(p).toContain("Japanese");
    expect(p).toContain("polite");
    expect(p).toContain("girlfriend's mother");
  });

  it("platform admins issue codes (paid ones need an end date), set plans and move groups between accounts", async () => {
    const w = await paidWorld();
    const boss = (await w.call("POST", "/api/session", { idToken: "ok:boss" })).data.session as string;
    const other = (await w.call("POST", "/api/session", { idToken: "ok:someone" })).data.session as string;

    expect((await w.call("POST", "/api/admin/codes", { plan: "advanced" }, boss)).status).toBe(400);
    expect((await w.call("POST", "/api/admin/codes", { plan: "advanced", planUntil: "2026-12-31" }, boss)).data[0]).toMatchObject({ plan: "advanced" });
    expect((await w.call("POST", "/api/admin/codes", { kind: "topup" }, boss)).data[0]).toMatchObject({ kind: "topup", chars: 500_000 });

    expect((await w.call("GET", "/api/admin/accounts", undefined, other)).status).toBe(403);
    const list = await w.call("GET", "/api/admin/accounts", undefined, boss);
    expect(list.data).toEqual([expect.objectContaining({ accountId: A1, planId: "starter", limit: 300_000, topUp: null })]);
    const put = await w.call("PUT", `/api/admin/accounts/${encodeURIComponent(A1)}`, { plan: "advanced", planUntil: "2100-01-31", bonusAdd: 100_000 }, boss);
    expect(put.data).toMatchObject({ planId: "advanced", planUntil: "2100-01-31", bonusChars: 100_000, limit: 1_500_000 });

    const groups = await w.call("GET", "/api/admin/groups", undefined, boss);
    expect(groups.data.find((g: { groupId: string }) => g.groupId === "Ca")).toMatchObject({ accountId: A1, effectivePlan: "advanced", limit: 1_500_000 });
    await w.accounts.ensure("default", "U2");
    expect((await w.call("PUT", "/api/admin/groups/Ca", { accountId: A2 }, boss)).data).toMatchObject({ accountId: A2 });
    expect((await w.call("PUT", "/api/admin/groups/Ca", { accountId: "default:nobody" }, boss)).status).toBe(400);
    await w.call("PUT", "/api/admin/groups/Ca", { accountId: "" }, boss);
    expect((await w.repo.get("Ca"))?.accountId).toBeFalsy();
  });
});

describe("Claude translation requests", () => {
  const capture = () => {
    const bodies: Record<string, any>[] = [];
    const f = (async (_url: unknown, init?: { body?: unknown }) => {
      bodies.push(JSON.parse(String(init?.body)));
      const message = { id: "msg_1", type: "message", role: "assistant", model: "m", content: [{ type: "text", text: "Hello" }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } };
      return new Response(JSON.stringify(message), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    return { bodies, f };
  };
  const env = { LINE_CHANNEL_SECRET: "s", LINE_CHANNEL_ACCESS_TOKEN: "t", DB: {} as D1Database, ANTHROPIC_API_KEY: "a" };

  it("Haiku runs with thinking off unless asked to think (the free plan never is)", async () => {
    const { bodies, f } = capture();
    expect(await engines.claude!("你好", "en", env, { model: "claude-haiku-5-5" }, f)).toBe("Hello");
    expect(bodies[0]).toMatchObject({ model: "claude-haiku-5-5", thinking: { type: "disabled" }, output_config: { effort: "low" } });
    expect(bodies[0]!.fallbacks).toBeUndefined();
    await engines.claude!("你好", "en", env, { model: "claude-haiku-5-5", think: true }, f);
    expect(bodies[1]!.thinking).toBeUndefined(); // the model's default: adaptive
  });

  it("paid plans translate with thinking on, the free plan with it off", async () => {
    const spy = vi.spyOn(engines, "claude").mockResolvedValue("Good morning");
    const paid = await paidWorld("starter");
    await handleEvent(msg("大家早安", "U1", "Ca"), paid.deps);
    expect(spy.mock.calls.at(-1)![3]).toMatchObject({ think: true });
    const free = world();
    const c = await free.code();
    await handleEvent(msg(`/activate ${c.code}`), free.deps);
    await handleEvent(msg("大家早安"), free.deps);
    expect(spy.mock.calls.at(-1)![3]).toMatchObject({ think: false });
    spy.mockRestore();
  });

  it("Opus keeps its default thinking (it rejects disabled) and the refusal fallback", async () => {
    const { bodies, f } = capture();
    await engines.claude!("你好", "en", env, { model: "claude-opus-5-5" }, f);
    expect(bodies[0]!.thinking).toBeUndefined();
    expect(bodies[0]).toMatchObject({ fallbacks: "default" });
  });
});

describe("cleaning Claude's output", () => {
  // Real outputs from a measurement run with the earlier prompt.
  it("keeps only the final answer when the model corrected itself", () => {
    const out = [
      "Trimmer beam dan joist harus diukur dulu baru dipotong, jangan langsung dipotong.",
      "",
      "Wait, the glossary says 收頭樑 = trimmer beam and 格柵 = joist, so I should use those terms exactly. Corrected:",
      "",
      "Trimmer beam dan joist harus diukur dulu baru dipotong, jangan langsung dipotong.",
    ].join("\n");
    expect(cleanTranslation(out, "收頭樑跟格柵都要先量好再裁，不要直接切")).toBe("Trimmer beam dan joist harus diukur dulu baru dipotong, jangan langsung dipotong.");
  });

  it("refuses to post when nothing but commentary is left", () => {
    expect(() => cleanTranslation("Wait, I need to check the glossary first.", "收頭樑")).toThrow(/commentary/);
  });

  it("drops quotation marks the model added, but keeps the ones the member wrote", () => {
    expect(cleanTranslation('"What about that one?"', "那個呢？")).toBe("What about that one?");
    expect(cleanTranslation("「那個呢？」", "What about that one?")).toBe("那個呢？");
    expect(cleanTranslation('"Ship it" was his answer.', '"出貨"是他的回答')).toBe('"Ship it" was his answer.');
    expect(cleanTranslation('"OK"', '"好"')).toBe('"OK"');
  });

  it("leaves ordinary translations alone, including ones that merely start with similar words", () => {
    expect(cleanTranslation("  Have you eaten yet, sweetheart?  ", "你吃飯了嗎？")).toBe("Have you eaten yet, sweetheart?");
    expect(cleanTranslation("Waiting for the truck now.", "在等卡車")).toBe("Waiting for the truck now.");
  });
});
