import type { LineMessage, Plugin, QuickItem } from "../../core/types";
import { action, text, withQuickReply } from "../../core/types";
import type { Row } from "../../storage/types";
import { backfill, flagged, translateLabel, withTranslations } from "../translate/terms";

/**
 * Task & progress tracking, stored in the "tasks" table (a sheet tab).
 *
 *   /task                                   list open tasks
 *   /task add <title> [@name|owner:name] [10/20|due:10/20]
 *   /task start <id>
 *   /task done <id>
 *   /task assign <id> <name>
 *
 * Phone shortcuts: /add … is /task add …, /todo is /task. The open-task list is a
 * card with Start/Done buttons per task, so most updates are a tap, not typing.
 *
 * Settings (group.settings.tasks):
 *   digest: true  – push a summary of open tasks on each cron run (uses push quota; default off;
 *                   only on plans that include it)
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

const LIST: QuickItem = { label: "📋 任務 Tasks", text: "/todo" };

export const tasks: Plugin = {
  name: "tasks",
  commands: ["task", "add", "todo"],
  help: {
    title: "📋 任務 Tasks",
    lines: [
      "/add 買早餐 @JOJO 10/17　新增（@負責人、日期可省略）",
      "/todo　看清單，點「開始」「完成」",
      "/task assign 1 JOJO　把 1 號任務改給 JOJO",
    ],
  },
  templates: [
    { label: "新增任務", text: "/add 工作內容 @負責人 10/20", note: "@負責人、日期可以刪掉" },
    { label: "改負責人", text: "/task assign 任務編號 名字" },
  ],
  quickReplies: [LIST],

  async onCommand(input, ctx) {
    // "/add …" and "/todo" are shorthands for "/task add …" and "/task".
    const args = input.name === "add" ? ["add", ...input.args] : input.name === "todo" ? [] : input.args;
    const [first, ...restArgs] = args;
    const sub = first ? SUB[first.toLowerCase()] : "list";
    const db = ctx.storage;

    switch (sub) {
      case "list":
      case undefined: {
        const open = await backfill((await db.list(TABLE)).filter((r) => r.status !== STATUS.done), "title", TABLE, db, ctx);
        return [open.length ? taskList(open) : text("✅ 目前沒有未完成的任務 No open tasks\n新增 Add: /add 內容 @負責人 10/17")];
      }
      case "add": {
        const { title, owner, due } = parseAdd(restArgs.join(" "));
        if (!title) return [text("用法 Usage: /add <內容> @負責人 期限\n例 e.g. /add 買早餐 @JOJO 10/17\n負責人、期限可省略 Owner and due date are optional")];
        const [by, i18n] = await Promise.all([ctx.displayName(input.userId).then((n) => n ?? ""), translateLabel(title, ctx)]);
        const row = await db.append(TABLE, {
          title,
          ...(i18n ? { i18n } : {}),
          owner: owner ?? by,
          due: due ?? "",
          status: STATUS.todo,
          createdBy: by,
          createdAt: new Date(input.event.timestamp).toISOString(),
        });
        return [withQuickReply(text(`➕ 已新增 Added\n${fmt(row)}`), [startOf(row), doneOf(row)])];
      }
      case "start":
      case "done": {
        const id = restArgs[0];
        if (!id) return [text(`用法 Usage: /task ${sub} <編號 id>\n或點 /todo 清單裡的按鈕 Or tap a button in /todo`)];
        const row = await db.update(TABLE, id, {
          status: sub === "start" ? STATUS.doing : STATUS.done,
          ...(sub === "done" ? { doneAt: new Date(input.event.timestamp).toISOString() } : {}),
        });
        if (!row) return [text(`找不到任務 #${id} / Task #${id} not found`)];
        const reply = text(`${sub === "done" ? "✅" : "▶️"} ${fmt(row)}`);
        return [sub === "start" ? withQuickReply(reply, [doneOf(row)]) : reply];
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
    if (ctx.settings.digest !== true || !ctx.plan.digest) return;
    const all = await ctx.storage.list(TABLE);
    const open = all.filter((r) => r.status !== STATUS.done);
    if (!open.length) return;
    const done = all.length - open.length;
    await ctx.push([text(`🗓 每週進度 Weekly progress\n完成 Done ${done}／共 Total ${all.length}\n\n${open.map(fmt).join("\n")}`)]);
  },
};

const startOf = (r: Row): QuickItem => ({ label: `▶️ 開始 #${r.id}`, text: `/task start ${r.id}` });
const doneOf = (r: Row): QuickItem => ({ label: `✅ 完成 #${r.id}`, text: `/task done ${r.id}` });

/** Rows shown in the card: LINE caps a bubble at 30 KB, and long lists are hard to read on a phone. */
const MAX_CARD_ROWS = 10;

/** Open tasks as a Flex card with tap-to-send Start/Done buttons on each row. */
function taskList(open: Row[]): LineMessage {
  const shown = open.slice(0, MAX_CARD_ROWS);
  const rows = shown.map((r) => {
    const meta = [r.status, r.owner && `👤${r.owner}`, r.due && `⏰${r.due}`].filter(Boolean).join("  ");
    const buttons = [
      ...(r.status === STATUS.todo ? [{ item: startOf(r), style: "secondary" }] : []),
      { item: doneOf(r), style: "primary" },
    ].map(({ item, style }) => ({
      type: "button",
      action: action({ label: item.label.replace(/ #\d+$/, ""), text: item.text }),
      style,
      height: "sm",
    }));
    return {
      type: "box",
      layout: "vertical",
      spacing: "sm",
      contents: [
        { type: "text", text: `#${r.id} ${r.title}`, weight: "bold", size: "sm", wrap: true },
        ...(flagged(r.i18n) ? [{ type: "text", text: flagged(r.i18n), size: "xs", color: "#555555", wrap: true }] : []),
        { type: "text", text: meta, size: "xs", color: "#888888", wrap: true },
        { type: "box", layout: "horizontal", spacing: "sm", contents: buttons },
      ],
    };
  });
  const more = open.length - shown.length;
  const footer = more > 0 ? [{ type: "text", text: `還有 ${more} 筆 +${more} more`, size: "xs", color: "#888888" }] : [];
  return {
    type: "flex",
    // Shown in notifications and chat previews, where the card itself is not.
    altText: `📋 未完成任務 Open tasks\n${open.map(fmt).join("\n")}`.slice(0, 400),
    contents: {
      type: "bubble",
      body: {
        type: "box",
        layout: "vertical",
        spacing: "lg",
        contents: [{ type: "text", text: `📋 未完成任務 Open tasks (${open.length})`, weight: "bold" }, ...rows, ...footer],
      },
    },
  };
}

function fmt(r: Row): string {
  const parts = [`#${r.id} ${withTranslations(r.title ?? "", r.i18n)}`, `[${r.status}]`];
  if (r.owner) parts.push(`👤${r.owner}`);
  if (r.due) parts.push(`⏰${r.due}`);
  return parts.join(" ");
}

/** A trailing date such as 10/20, 10-20 or 2026/10/20 is taken as the due date. */
const TRAILING_DATE = /\s+((?:\d{4}[/-])?\d{1,2}[/-]\d{1,2})$/;

/**
 * Pull the owner ("owner:name" or "@name") and due date ("due:10/20" or a
 * trailing date) out of free text; the rest is the title.
 */
export function parseAdd(s: string): { title: string; owner?: string; due?: string } {
  let owner: string | undefined;
  let due: string | undefined;
  let title = s
    .replace(/owner[:：]\s*(\S+)/i, (_, v: string) => ((owner = v), ""))
    .replace(/due[:：]\s*(\S+)/i, (_, v: string) => ((due = v), ""))
    .replace(/(?:^|\s)[@＠](\S+)/, (_, v: string) => ((owner ??= v), ""))
    .replace(/\s+/g, " ")
    .trim();
  if (!due) title = title.replace(TRAILING_DATE, (_, v: string) => ((due = v.replace(/-/g, "/")), "")).trim();
  return { title, owner, due };
}
