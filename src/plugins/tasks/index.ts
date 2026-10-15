import type { Plugin } from "../../core/types";
import { text } from "../../core/types";
import type { Row } from "../../storage/types";

/**
 * Task & progress tracking, stored in the "tasks" table (a sheet tab).
 *
 *   /task                                   list open tasks
 *   /task add <title> [owner:name] [due:10/20]
 *   /task start <id>
 *   /task done <id>
 *   /task assign <id> <name>
 *
 * Settings (group.settings.tasks):
 *   digest: true  – push a summary of open tasks on each cron run (uses push quota; default off)
 *
 * This plugin is the reference for writing new ones (roster, tools, logistics, shortages):
 * parse the command, read/write a table through ctx.storage, return reply messages.
 */
const TABLE = "tasks";
const STATUS = { todo: "未開始", doing: "進行中", done: "完成" } as const;

const SUB: Record<string, "add" | "start" | "done" | "assign" | "list"> = {
  add: "add",
  start: "start",
  done: "done",
  assign: "assign",
  list: "list",
};

export const tasks: Plugin = {
  name: "tasks",
  commands: ["task"],

  async onCommand(input, ctx) {
    const [first, ...restArgs] = input.args;
    const sub = first ? SUB[first] : "list";
    const db = ctx.storage;

    switch (sub) {
      case "list":
      case undefined: {
        const open = (await db.list(TABLE)).filter((r) => r.status !== STATUS.done);
        return [text(open.length ? `📋 未完成任務 Open tasks\n${open.map(fmt).join("\n")}` : "✅ 目前沒有未完成的任務 No open tasks")];
      }
      case "add": {
        const { title, owner, due } = parseAdd(restArgs.join(" "));
        if (!title) return [text("用法 Usage: /task add <內容 title> [owner:名字 name] [due:10/20]")];
        const by = (await ctx.displayName(input.userId)) ?? "";
        const row = await db.append(TABLE, {
          title,
          owner: owner ?? by,
          due: due ?? "",
          status: STATUS.todo,
          createdBy: by,
          createdAt: new Date(input.event.timestamp).toISOString(),
        });
        return [text(`➕ 已新增 Added\n${fmt(row)}`)];
      }
      case "start":
      case "done": {
        const id = restArgs[0];
        if (!id) return [text(`用法 Usage: /task ${sub} <編號 id>`)];
        const row = await db.update(TABLE, id, {
          status: sub === "start" ? STATUS.doing : STATUS.done,
          ...(sub === "done" ? { doneAt: new Date(input.event.timestamp).toISOString() } : {}),
        });
        return [text(row ? `${sub === "done" ? "✅" : "▶️"} ${fmt(row)}` : `找不到任務 #${id} / Task #${id} not found`)];
      }
      case "assign": {
        const [id, ...who] = restArgs;
        if (!id || !who.length) return [text("用法 Usage: /task assign <編號 id> <名字 name>")];
        const row = await db.update(TABLE, id, { owner: who.join(" ") });
        return [text(row ? `👤 ${fmt(row)}` : `找不到任務 #${id} / Task #${id} not found`)];
      }
    }
  },

  async onSchedule(_cron, ctx) {
    if (ctx.settings.digest !== true) return;
    const all = await ctx.storage.list(TABLE);
    const open = all.filter((r) => r.status !== STATUS.done);
    if (!open.length) return;
    const done = all.length - open.length;
    await ctx.push([text(`🗓 每週進度 Weekly progress\n完成 Done ${done}／共 Total ${all.length}\n\n${open.map(fmt).join("\n")}`)]);
  },
};

function fmt(r: Row): string {
  const parts = [`#${r.id} ${r.title}`, `[${r.status}]`];
  if (r.owner) parts.push(`👤${r.owner}`);
  if (r.due) parts.push(`⏰${r.due}`);
  return parts.join(" ");
}

/** Pull "owner:name" and "due:10/20" out of free text. */
export function parseAdd(s: string): { title: string; owner?: string; due?: string } {
  let owner: string | undefined;
  let due: string | undefined;
  const title = s
    .replace(/owner[:：]\s*(\S+)/i, (_, v: string) => ((owner = v), ""))
    .replace(/due[:：]\s*(\S+)/i, (_, v: string) => ((due = v), ""))
    .replace(/\s+/g, " ")
    .trim();
  return { title, owner, due };
}
