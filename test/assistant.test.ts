import type Anthropic from "@anthropic-ai/sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleEvent, type Deps } from "../src/core/dispatcher";
import type { LineApi } from "../src/core/line";
import type { GroupConfig, LineEvent, LineMessage } from "../src/core/types";
import { plugins } from "../src/plugins";
import { MemoryAdminRepo } from "../src/storage/admins";
import { MemoryCodeRepo } from "../src/storage/codes";
import { MemoryGroupRepo, MemoryUsageMeter } from "../src/storage/groups";
import { MemoryStorage } from "../src/storage/memory";

// The dispatcher tests below swap interpret() for a stub; the interpret tests use the real one.
vi.mock("../src/core/assistant", async (original) => {
  const real = await original<typeof import("../src/core/assistant")>();
  return { ...real, interpret: vi.fn(real.interpret), realInterpret: real.interpret };
});
const assistant = (await import("../src/core/assistant")) as typeof import("../src/core/assistant") & {
  realInterpret: typeof import("../src/core/assistant").interpret;
};

const fakeClient = (json: unknown, stop_reason = "end_turn") => {
  const create = vi.fn(async () => ({ stop_reason, content: [{ type: "text", text: JSON.stringify(json) }] }));
  return { client: { beta: { messages: { create } } } as unknown as Anthropic, create };
};
const env = { LINE_CHANNEL_SECRET: "s", LINE_CHANNEL_ACCESS_TOKEN: "t", DB: {} as D1Database, ANTHROPIC_API_KEY: "k" };
const input = (request: string) => ({ request, speaker: "Tuấn", plugins: [plugins.tasks!, plugins.tools!], openTasks: [], counts: [], today: "2026-10-16" });

describe("interpret", () => {
  it("asks Claude for a JSON decision with low effort and the default fallback", async () => {
    const { client, create } = fakeClient({ kind: "command", command: "/tool 線鋸 2", reply: "Thêm 2 線鋸?" });
    expect(await assistant.realInterpret(env, input("thêm 2 cái 線鋸"), client)).toEqual({ kind: "command", command: "/tool 線鋸 2", reply: "Thêm 2 線鋸?" });
    const params = (create.mock.calls[0] as unknown[])[0] as Record<string, any>;
    expect(params.model).toBe("claude-opus-5-5");
    expect(params.output_config).toMatchObject({ effort: "low", format: { type: "json_schema" } });
    expect(params).toMatchObject({ fallbacks: "default", betas: ["server-side-fallback-2026-07-01"] });
    expect(params.tool_choice).toBeUndefined();
    expect(params.messages[0].content).toContain("/tool 線鋸 1");
  });

  it("never lets the AI run blocked or unknown commands", async () => {
    for (const command of ["/activate ABCD", "/admin add @x", "/rm -rf"]) {
      const { client } = fakeClient({ kind: "command", command, reply: "ok" });
      expect((await assistant.realInterpret(env, input("x"), client)).kind).toBe("answer");
    }
  });

  it("answers politely on a refusal", async () => {
    const { client } = fakeClient({}, "refusal");
    expect(await assistant.realInterpret(env, input("x"), client)).toMatchObject({ kind: "answer" });
  });

  it("strips only the bot's own mention", () => {
    const text = "@工班通 新增任務 @阿明 買螺絲";
    expect(assistant.stripSelfMention(text, [{ index: 0, length: 4, isSelf: true }, { index: 10, length: 3 }])).toBe("新增任務 @阿明 買螺絲");
  });
});

describe("@bot in a group", () => {
  const interpret = assistant.interpret as unknown as ReturnType<typeof vi.fn>;
  beforeEach(() => interpret.mockReset());

  function world(plan: string) {
    const replies: LineMessage[][] = [];
    const line: LineApi = {
      reply: async (_t, m) => void replies.push(m),
      push: async () => {},
      groupMemberName: async () => "Tuấn",
      groupName: async () => "工班",
    };
    const storage = new MemoryStorage();
    const group: GroupConfig = { groupId: "Cg", status: "active", plan, plugins: ["tasks", "tools"], storage: { type: "memory" }, settings: {} };
    const usage = new MemoryUsageMeter();
    const deps: Deps = {
      env,
      line,
      channel: { id: "default", joinPolicy: "code" },
      groups: new MemoryGroupRepo([group]),
      admins: new MemoryAdminRepo(),
      codes: new MemoryCodeRepo(),
      usage,
      plugins,
      storageFor: () => storage,
      origin: "https://bot.example",
    };
    return { deps, replies, storage, usage };
  }
  const mention = (request: string): LineEvent => ({
    type: "message",
    replyToken: "r",
    timestamp: 0,
    source: { type: "group", groupId: "Cg", userId: "U2" },
    message: { type: "text", id: "m", text: `@工班通 ${request}`, mention: { mentionees: [{ index: 0, length: 4, isSelf: true }] } },
  });
  const textOf = (m: LineMessage | undefined) => (m as { text: string }).text;

  it("is a Pro feature", async () => {
    const w = world("free");
    await handleEvent(mention("thêm 2 cái 線鋸"), w.deps);
    expect(textOf(w.replies[0]?.[0])).toContain("專業版功能");
    expect(interpret).not.toHaveBeenCalled();
  });

  it("asks for a tap before changing data, and the tap runs the command", async () => {
    const w = world("pro");
    interpret.mockResolvedValue({ kind: "command", command: "/tool 線鋸 2", reply: "Thêm 2 線鋸?" });
    await handleEvent(mention("thêm 2 cái 線鋸"), w.deps);
    const card = w.replies[0]?.[0] as { type: string; template: { text: string; actions: { type: string; data: string }[] } };
    expect(card.type).toBe("template");
    expect(card.template.text).toContain("Thêm 2 線鋸?");
    expect(card.template.actions[0]).toMatchObject({ type: "postback", data: "/tool 線鋸 2" });
    expect(await w.storage.list("tools")).toEqual([]);
    expect(await w.usage.get("Cg", "ai_requests")).toBe(1);

    await handleEvent({ type: "postback", replyToken: "r2", timestamp: 0, source: { type: "group", groupId: "Cg", userId: "U2" }, postback: { data: "/tool 線鋸 2" } }, w.deps);
    expect((await w.storage.list("tools"))[0]).toMatchObject({ name: "線鋸", qty: "2" });
  });

  it("runs read-only commands straight away", async () => {
    const w = world("pro");
    interpret.mockResolvedValue({ kind: "command", command: "/todo", reply: "Here are the tasks" });
    await handleEvent(mention("có việc gì không"), w.deps);
    expect(textOf(w.replies[0]?.[0])).toContain("目前沒有未完成的任務");
  });

  it("answers in words, and degrades gracefully when the API fails", async () => {
    const w = world("pro");
    interpret.mockResolvedValueOnce({ kind: "answer", reply: "Bấm nút 📋 để xem việc." });
    await handleEvent(mention("làm sao xem việc"), w.deps);
    expect(textOf(w.replies[0]?.[0])).toBe("🤖 Bấm nút 📋 để xem việc.");

    interpret.mockRejectedValueOnce(new Error("529 overloaded"));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await handleEvent(mention("làm sao xem việc"), w.deps);
    expect(textOf(w.replies[1]?.[0])).toContain("AI 助理暫時無法使用");
    err.mockRestore();
  });
});
