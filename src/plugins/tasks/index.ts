import type { LineMessage, Plugin, QuickItem } from "../../core/types";
import { action, tag, text, withQuickReply } from "../../core/types";
import type { Row } from "../../storage/types";
import { backfill, flagged, translateLabel, withTranslations } from "../translate/terms";

/**
 * Task & progress tracking, stored in the "tasks" table (a sheet tab).
 *
 *   /task                                   list open tasks
 *   /task add <title> [@name|owner:name] [10/20|due:10/20]
 *   /task start <id>
 *   /task done <id> <report>                done, with a report of how it went; without
 *                                           one, the next plain message from the same
 *                                           member within 10 minutes is the report
 *   /task fail <id> [reason]                mark as failed; reason optional
 *   /task assign <id> <name>
 *
 * Done and failed tasks are closed: they leave /todo and the digest. Starting a
 * failed task again reopens it.
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
export const STATUS = { todo: "未開始", doing: "進行中", done: "完成", failed: "失敗" } as const;

/** Done and failed tasks are closed; everything else is still open. */
export const isOpen = (r: Row) => r.status !== STATUS.done && r.status !== STATUS.failed;

const SUB: Record<string, "add" | "start" | "done" | "fail" | "assign" | "list"> = {
  add: "add",
  start: "start",
  done: "done",
  fail: "fail",
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
      "/todo　看清單，點「開始」「完成」「失敗」",
      "點「完成」後直接回覆現況，例：租到 2 台，週五可取",
      "/task done 1 租到 2 台，週五可取　一次完成並回報",
      "/task fail 1 下雨延期　標記 1 號失敗（原因可省略）",
      "/task assign 1 JOJO　把 1 號任務改給 JOJO",
    ],
  },
  templates: [
    { label: "新增任務", text: "/add 工作內容 @負責人 10/20", note: "@負責人、日期可以刪掉" },
    { label: "完成並回報現況", text: "/task done 任務編號 現況說明", note: "例：租到 2 台線鋸，週五下午可以取" },
    { label: "標記失敗", text: "/task fail 任務編號 原因", note: "原因可以刪掉" },
    { label: "改負責人", text: "/task assign 任務編號 名字" },
  ],
  quickReplies: [LIST],

  /** A plain message from someone who just tapped Done is their report: complete the task with it. */
  async onMessage(input, ctx) {
    if (!input.userId) return;
    const pending = await pendingFor(ctx, input.userId, input.event.timestamp);
    if (pending) {
      pendingCache.delete(ctx.group.groupId);
      return [await complete(ctx, pending, input.text.trim(), input.event.timestamp)];
    }
    // A long-press "Reply" to one of the bot's task messages, starting with done / fail / start.
    const quoted = input.event.message?.quotedMessageId;
    const verb = quoted ? quoteVerb(input.text) : undefined;
    if (!quoted || !verb) return;
    const row = (await ctx.storage.list(TABLE)).find((r) => (r.msgIds ?? "").split(",").includes(quoted));
    if (!row) return;
    const at = input.event.timestamp;
    if (verb.kind === "done") {
      if (row.status === STATUS.done) return [text(`✅ ${fmt(row)}\n這個任務已經完成了 Already done.`)];
      if (verb.rest) return [await complete(ctx, row, verb.rest, at)];
      return [await askReport(ctx, row, input.userId, at)];
    }
    if (verb.kind === "fail") return [await fail(ctx, row.id, verb.rest, at)];
    const started = await ctx.storage.update(TABLE, row.id, { status: STATUS.doing, failReason: "" });
    return [tagTask(withQuickReply(text(`▶️ ${fmt(started ?? row)}`), [doneOf(row)]), row.id)];
  },

  /** Remember which LINE messages are about which task, so a quote of one finds it. */
  async onSent(key, messageId, ctx) {
    const row = (await ctx.storage.list(TABLE)).find((r) => r.id === key);
    if (!row) return;
    const ids = [...(row.msgIds ? row.msgIds.split(",") : []), messageId].slice(-MAX_MSG_IDS);
    await ctx.storage.update(TABLE, key, { msgIds: ids.join(",") });
  },

  async onCommand(input, ctx) {
    // "/add …" and "/todo" are shorthands for "/task add …" and "/task".
    const args = input.name === "add" ? ["add", ...input.args] : input.name === "todo" ? [] : input.args;
    const [first, ...restArgs] = args;
    const sub = first ? SUB[first.toLowerCase()] : "list";
    const db = ctx.storage;

    switch (sub) {
      case "list":
      case undefined: {
        const open = await backfill((await db.list(TABLE)).filter(isOpen), "title", TABLE, db, ctx);
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
        return [tagTask(withQuickReply(text(`➕ 已新增 Added\n${fmt(row)}`), [startOf(row), doneOf(row)]), row.id)];
      }
      case "start": {
        const id = restArgs[0];
        if (!id) return [text("用法 Usage: /task start <編號 id>\n或點 /todo 清單裡的按鈕 Or tap a button in /todo")];
        // Starting again (e.g. after a failure) clears the failure reason.
        const row = await db.update(TABLE, id, { status: STATUS.doing, failReason: "" });
        if (!row) return [text(`找不到任務 #${id} / Task #${id} not found`)];
        return [tagTask(withQuickReply(text(`▶️ ${fmt(row)}`), [doneOf(row)]), row.id)];
      }
      case "done": {
        const [id, ...words] = restArgs;
        if (!id) return [text("用法 Usage: /task done <編號 id> <現況 report>\n例 e.g. /task done 3 租到 2 台，週五可取")];
        const row = (await db.list(TABLE)).find((r) => r.id === id);
        if (!row) return [text(`找不到任務 #${id} / Task #${id} not found`)];
        if (row.status === STATUS.done) return [text(`✅ ${fmt(row)}\n這個任務已經完成了 Already done.`)];
        const report = words.join(" ").trim();
        if (report) return [await complete(ctx, row, report, input.event.timestamp)];
        // No report yet: wait for the member's next plain message as the report.
        if (!input.userId) return [text("請附上現況 Please add a report: /task done " + id + " <現況>")];
        return [await askReport(ctx, row, input.userId, input.event.timestamp)];
      }
      case "fail": {
        const [id, ...why] = restArgs;
        if (!id) return [text("用法 Usage: /task fail <編號 id> [原因 reason]\n例 e.g. /task fail 3 下雨延期")];
        return [await fail(ctx, id, why.join(" "), input.event.timestamp)];
      }
      case "assign": {
        const [id, ...who] = restArgs;
        if (!id || !who.length) return [text("用法 Usage: /task assign <編號 id> <名字 name>")];
        // "@JOJO" (typed or picked from LINE's mention list) is stored as "JOJO", like /add does.
        const row = await db.update(TABLE, id, { owner: who.join(" ").replace(/^[@＠]/, "") });
        return [row ? tagTask(text(`👤 ${fmt(row)}`), row.id) : text(`找不到任務 #${id} / Task #${id} not found`)];
      }
    }
  },

  async onSchedule(_cron, ctx) {
    if (ctx.settings.digest !== true || !ctx.plan.digest) return;
    const all = await ctx.storage.list(TABLE);
    const open = all.filter(isOpen);
    if (!open.length) return;
    const done = all.filter((r) => r.status === STATUS.done).length;
    const failed = all.filter((r) => r.status === STATUS.failed).length;
    const closed = `完成 Done ${done}${failed ? `、失敗 Failed ${failed}` : ""}`;
    await ctx.push([text(`🗓 每週進度 Weekly progress\n${closed}／共 Total ${all.length}\n\n${open.map(fmt).join("\n")}`)]);
  },
};

/** How long after tapping Done the member's next message counts as the report. */
export const REPORT_WINDOW_MS = 10 * 60 * 1000;

type Ctx = Parameters<NonNullable<Plugin["onCommand"]>>[1];

/** Mark a task done with its report, clearing any wait for one. */
async function complete(ctx: Ctx, row: Row, report: string, timestamp: number): Promise<LineMessage> {
  const done = await ctx.storage.update(TABLE, row.id, {
    status: STATUS.done,
    doneAt: new Date(timestamp).toISOString(),
    report,
    reportBy: "",
    reportUntil: "",
  });
  return tagTask(text(`✅ ${fmt(done ?? row)}\n📝 回報 Report：${report}`), row.id);
}

async function fail(ctx: Ctx, id: string, reason: string, timestamp: number): Promise<LineMessage> {
  const row = await ctx.storage.update(TABLE, id, { status: STATUS.failed, failedAt: new Date(timestamp).toISOString(), failReason: reason });
  if (!row) return text(`找不到任務 #${id} / Task #${id} not found`);
  return tagTask(withQuickReply(text(`❌ ${fmt(row)}`), [restartOf(row)]), row.id);
}

/** Wait for this member's next plain message (or quote) as the task's report. */
async function askReport(ctx: Ctx, row: Row, userId: string, timestamp: number): Promise<LineMessage> {
  await ctx.storage.update(TABLE, row.id, { reportBy: userId, reportUntil: new Date(timestamp + REPORT_WINDOW_MS).toISOString() });
  pendingCache.delete(ctx.group.groupId);
  const who = (await ctx.displayName(userId)) ?? "";
  return tagTask(
    text(
      `✍️ 請 ${who} 直接回覆一則訊息，說明 #${row.id} 的現況（10 分鐘內）。\n例如：租到 2 台線鋸，週五下午可以取。\n\nReply with a message describing the outcome; it completes the task.\n也可以打 Or: /task done ${row.id} 現況`,
    ),
    row.id,
  );
}

/** Messages about one task are tagged with its id, so quoting them later finds the task. */
const tagTask = (m: LineMessage, id: string) => tag(m, "tasks", id);

/** How many recent message IDs a task keeps for quote lookups. */
const MAX_MSG_IDS = 10;

/**
 * Words that start a quoted reply to a task message, in the group's languages.
 * Anything else is ordinary chat, so asking a question about a task never closes it.
 */
const QUOTE_VERBS: { kind: "done" | "fail" | "start"; words: string[] }[] = [
  { kind: "done", words: ["完成", "做完", "done", "finished", "xong", "hoàn thành", "selesai", "tapos", "เสร็จ", "完了"] },
  { kind: "fail", words: ["失敗", "fail", "failed", "thất bại", "không được", "gagal", "hindi natuloy", "ไม่สำเร็จ", "失敗した"] },
  { kind: "start", words: ["開始", "start", "bắt đầu", "mulai", "simula", "เริ่ม", "開始します"] },
];

export function quoteVerb(textIn: string): { kind: "done" | "fail" | "start"; rest: string } | undefined {
  const t = textIn.trim();
  // A question about the task ("完成了嗎？", "done?") never changes it.
  if (/[?？嗎吗]\s*$/.test(t)) return undefined;
  const lower = t.toLowerCase();
  for (const v of QUOTE_VERBS) {
    // Longest word first, so "失敗した" wins over "失敗".
    for (const w of [...v.words].sort((a, b) => b.length - a.length)) {
      if (!lower.startsWith(w)) continue;
      const next = t.slice(w.length, w.length + 1);
      // Latin words must end at a word boundary ("done" but not "donation").
      if (/[a-z]$/i.test(w) && next && /[a-z]/i.test(next)) continue;
      // "完成了，租到 2 台" → report "租到 2 台".
      return { kind: v.kind, rest: t.slice(w.length).replace(/^了?[\s,，:：、。.!！-]*/, "").trim() };
    }
  }
  return undefined;
}

/**
 * Tasks waiting for a report, per group, re-read at most every few seconds so a
 * busy chat does not read the task table on every message. The isolate that
 * records a wait clears its cache; others catch up within PENDING_TTL_MS.
 */
const PENDING_TTL_MS = 5 * 1000;
const pendingCache = new Map<string, { rows: Row[]; at: number }>();

/** Forget cached report waits, e.g. between tests. */
export const clearPendingCache = () => pendingCache.clear();

async function pendingFor(ctx: Ctx, userId: string, now: number): Promise<Row | undefined> {
  let hit = pendingCache.get(ctx.group.groupId);
  if (!hit || Date.now() - hit.at > PENDING_TTL_MS) {
    const rows = (await ctx.storage.list(TABLE)).filter((r) => r.reportBy && isOpen(r));
    hit = { rows, at: Date.now() };
    pendingCache.set(ctx.group.groupId, hit);
  }
  return hit.rows
    .filter((r) => r.reportBy === userId && new Date(r.reportUntil ?? 0).getTime() > now)
    .sort((a, b) => (b.reportUntil ?? "").localeCompare(a.reportUntil ?? ""))[0];
}

const startOf = (r: Row): QuickItem => ({ label: `▶️ 開始 #${r.id}`, text: `/task start ${r.id}` });
const doneOf = (r: Row): QuickItem => ({ label: `✅ 完成 #${r.id}`, text: `/task done ${r.id}` });
const failOf = (r: Row): QuickItem => ({ label: `❌ 失敗 #${r.id}`, text: `/task fail ${r.id}` });
const restartOf = (r: Row): QuickItem => ({ label: `🔄 重新開始 #${r.id}`, text: `/task start ${r.id}` });

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
      { item: failOf(r), style: "link", color: "#cc3333" },
    ].map(({ item, style, color }) => ({
      type: "button",
      action: action({ label: item.label.replace(/ #\d+$/, ""), text: item.text }),
      style,
      height: "sm",
      ...(color ? { color } : {}),
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
  if (r.status === STATUS.failed && r.failReason) parts.push(`（${r.failReason}）`);
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
