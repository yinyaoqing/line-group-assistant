import type { LineApi } from "./line";
import type { Env, GroupConfig, LineEvent, LineMessage, Plugin, PluginContext } from "./types";
import { text } from "./types";
import type { Storage } from "../storage/types";

export interface Deps {
  env: Env;
  line: LineApi;
  groups: GroupConfig[];
  plugins: Record<string, Plugin>;
  storageFor(group: GroupConfig): Storage;
}

const groupIdOf = (e: LineEvent) => e.source.groupId ?? e.source.roomId;

function context(deps: Deps, group: GroupConfig, plugin: Plugin): PluginContext {
  const names = new Map<string, string | undefined>();
  return {
    env: deps.env,
    group,
    storage: deps.storageFor(group),
    settings: group.settings?.[plugin.name] ?? {},
    async displayName(userId) {
      if (!userId) return undefined;
      if (!names.has(userId)) {
        try {
          names.set(userId, await deps.line.groupMemberName(group.groupId, userId));
        } catch {
          names.set(userId, undefined);
        }
      }
      return names.get(userId);
    },
    push: (messages) => deps.line.push(group.groupId, messages),
  };
}

/** Parse "/指令 a b c" into its parts; null if not a command. */
export function parseCommand(input: string): { name: string; args: string[]; rest: string } | null {
  const m = input.trim().match(/^\/(\S+)\s*([\s\S]*)$/);
  if (!m) return null;
  const rest = (m[2] ?? "").trim();
  return { name: m[1]!, args: rest ? rest.split(/\s+/) : [], rest };
}

/** Route one webhook event to the group's plugins and send a single merged reply. */
export async function handleEvent(event: LineEvent, deps: Deps): Promise<void> {
  const gid = groupIdOf(event);
  if (!gid) return; // 1:1 chats are not handled

  const group = deps.groups.find((g) => g.groupId === gid);

  // Bot just joined, or someone asks for the id: report it so the group can be configured.
  const asksId = event.message?.type === "text" && event.message.text?.trim() === "/id";
  if (event.type === "join" || asksId) {
    if (event.replyToken) {
      await deps.line.reply(event.replyToken, [
        text(
          group
            ? `此群組已設定：${group.name ?? gid}\nThis group is configured.\n啟用 Plugins: ${group.plugins.join(", ")}`
            : `群組 ID / Group ID:\n${gid}\n請把它加進 config/groups.ts 後重新部署。\nAdd it to config/groups.ts and redeploy.`,
        ),
      ]);
    }
    return;
  }
  if (!group) return;
  if (event.type !== "message" || event.message?.type !== "text" || !event.message.text) return;

  const raw = event.message.text;
  const cmd = parseCommand(raw);
  const replies: LineMessage[] = [];
  const active = group.plugins.map((n) => deps.plugins[n]).filter((p): p is Plugin => !!p);

  for (const plugin of active) {
    const ctx = context(deps, group, plugin);
    try {
      let out: LineMessage[] | void = undefined;
      if (cmd) {
        if (plugin.onCommand && plugin.commands?.includes(cmd.name)) {
          out = await plugin.onCommand({ ...cmd, text: raw, userId: event.source.userId, event }, ctx);
        }
      } else if (plugin.onMessage) {
        out = await plugin.onMessage({ text: raw, userId: event.source.userId, event }, ctx);
      }
      if (out) replies.push(...out);
    } catch (err) {
      console.error(`plugin ${plugin.name} failed`, err);
    }
  }

  if (cmd && cmd.name === "help") {
    const lines = active.flatMap((p) => (p.commands ?? []).map((c) => `/${c}`));
    replies.push(text(`可用指令 Commands:\n/id\n/help\n${lines.join("\n")}`));
  }

  if (replies.length && event.replyToken) await deps.line.reply(event.replyToken, replies.slice(0, 5));
}

/** Cron entry: run every group's plugins that have onSchedule. */
export async function handleSchedule(cron: string, deps: Deps): Promise<void> {
  for (const group of deps.groups) {
    for (const name of group.plugins) {
      const plugin = deps.plugins[name];
      if (!plugin?.onSchedule) continue;
      try {
        await plugin.onSchedule(cron, context(deps, group, plugin));
      } catch (err) {
        console.error(`schedule ${name} for ${group.groupId} failed`, err);
      }
    }
  }
}
