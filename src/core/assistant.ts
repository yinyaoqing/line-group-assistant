import Anthropic from "@anthropic-ai/sdk";
import type { Env, Plugin, PluginContext } from "./types";
import type { Row } from "../storage/types";

/**
 * "@bot …" in plain words, any language: Claude maps the request onto one of the
 * group's commands (or answers a question about using the bot). The command
 * then runs through the normal dispatcher, so the AI never touches data itself.
 */

/** Default model; override with the AI_MODEL variable (e.g. "claude-haiku-5-5" to cut cost). */
export const DEFAULT_AI_MODEL = "claude-opus-5-5";

/** Monthly AI requests per group are metered under this name. */
export const AI_METRIC = "ai_requests";

export type Decision = { kind: "command"; command: string; reply: string } | { kind: "answer"; reply: string };

/** Commands the AI may produce. Activation and admin changes stay manual. */
const BLOCKED = new Set(["activate", "admin", "settings", "id"]);

/** Commands that only read, so they run without asking for confirmation. */
export const isReadOnly = (command: string) =>
  /^\/(todo|tool|tools|material|materials|mat|report|help|menu|template|m|translate|lang)\s*$/i.test(command.trim()) ||
  /^\/task(\s+list)?\s*$/i.test(command.trim()) ||
  /^\/t\s/i.test(command.trim());

/** Remove the "@bot" mention (by LINE's index/length) so only the request is left. */
export function stripSelfMention(text: string, mentionees: { index: number; length: number; isSelf?: boolean }[] = []): string {
  let out = text;
  for (const m of [...mentionees].filter((x) => x.isSelf).sort((a, b) => b.index - a.index)) {
    out = out.slice(0, m.index) + out.slice(m.index + m.length);
  }
  return out.trim();
}

const SYSTEM = `You are the assistant inside a LINE work group (construction sites, factories; members speak Chinese, English, Vietnamese, Indonesian, Thai, Filipino or Japanese).
A member mentioned you with a request. Turn it into exactly one of the group's slash commands, listed below with examples, or answer briefly if they are asking how to use you.

Rules:
- Output JSON only, matching the schema. kind "command": put the full command line in "command" (it must start with "/" and use one of the listed commands; keep names, item names and task titles in the words the member used). kind "answer": leave "command" empty.
- "reply" is one short sentence in the member's language: for a command, what you are about to do (e.g. "Add 2 to 線鋸?"); for an answer, the answer.
- Refer to tasks by their number from the open-task list. Dates are M/D. Owners are written "@name".
- If the request is ambiguous or needs a command that is not listed, answer with a short clarifying question instead of guessing.`;

const SCHEMA = {
  type: "object",
  properties: {
    kind: { type: "string", enum: ["command", "answer"] },
    command: { type: "string" },
    reply: { type: "string" },
  },
  required: ["kind", "command", "reply"],
  additionalProperties: false,
};

export interface AssistantInput {
  request: string;
  speaker: string;
  /** Active plugins, for their command help. */
  plugins: Plugin[];
  /** Group data the request may refer to. */
  openTasks: Row[];
  counts: { kind: string; rows: Row[] }[];
  today: string;
}

/** Ask Claude which command the request means. Throws on API errors; callers reply with a fallback. */
export async function interpret(env: Env, input: AssistantInput, client?: Anthropic): Promise<Decision> {
  const api = client ?? new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const commands = input.plugins
    .filter((p) => p.help)
    .map((p) => [p.help!.title, ...p.help!.lines.map((l) => `  ${l}`), ...(p.templates ?? []).map((t) => `  ${t.text}　(${t.label})`)].join("\n"))
    .join("\n");
  const tasks = input.openTasks.map((r) => `#${r.id} ${r.title} (owner ${r.owner || "-"}, due ${r.due || "-"}, ${r.status})`).join("\n");
  const counts = input.counts.map((c) => `${c.kind}: ${c.rows.map((r) => `${r.name}×${r.qty}`).join(", ") || "(none)"}`).join("\n");
  const context = [
    `Today: ${input.today} (Taipei). Member: ${input.speaker}.`,
    `Commands:\n${commands}\n/report　export a report\n/help　usage help`,
    input.openTasks.length ? `Open tasks:\n${tasks}` : "Open tasks: (none)",
    counts ? `Counts:\n${counts}` : "",
    `Request: ${input.request}`,
  ]
    .filter(Boolean)
    .join("\n\n");

  const response = await api.beta.messages.create({
    model: env.AI_MODEL || DEFAULT_AI_MODEL,
    max_tokens: 2000,
    // A routing decision, not deep reasoning: low effort keeps it fast and cheap.
    output_config: { effort: "low", format: { type: "json_schema", schema: SCHEMA } },
    // If a safety classifier declines, the API retries on its recommended fallback model.
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: context }],
  });

  if (response.stop_reason === "refusal") return { kind: "answer", reply: "抱歉，這個要求我無法處理。Sorry, I can't help with that." };
  const textBlock = response.content.find((b) => b.type === "text");
  const parsed = JSON.parse(textBlock && "text" in textBlock ? textBlock.text : "{}") as { kind?: string; command?: string; reply?: string };
  const reply = (parsed.reply ?? "").trim() || "🤔";
  if (parsed.kind !== "command") return { kind: "answer", reply };

  const command = (parsed.command ?? "").trim();
  const name = command.match(/^\/(\S+)/)?.[1]?.toLowerCase();
  const known = new Set(["report", "help", "menu", "template", "m", ...input.plugins.flatMap((p) => p.commands ?? [])]);
  if (!name || BLOCKED.has(name) || !known.has(name)) return { kind: "answer", reply };
  return { kind: "command", command, reply };
}

/** The group data a request may refer to: open tasks and the count lists. */
export async function gatherContext(ctx: PluginContext): Promise<Pick<AssistantInput, "openTasks" | "counts">> {
  const plugins = new Set(ctx.group.plugins);
  const openTasks = plugins.has("tasks") ? (await ctx.storage.list("tasks")).filter((r) => r.status !== "完成" && r.status !== "失敗").slice(0, 40) : [];
  const counts = await Promise.all(
    ["tools", "materials"].filter((k) => plugins.has(k)).map(async (kind) => ({ kind, rows: (await ctx.storage.list(kind)).filter((r) => r.removed !== "1").slice(0, 60) })),
  );
  return { openTasks, counts };
}
