import type { LineMessage, Plugin, PluginContext, QuickItem } from "../../core/types";
import { action, text, withQuickReply } from "../../core/types";
import type { Row, Storage } from "../../storage/types";
import { backfill, flagged, translateLabel, translationsOf, withTranslations } from "../translate/terms";

/**
 * A count list, made into one plugin per kind of thing (tools, materials), each
 * with its own command and table. With command "tool":
 *
 *   /tool                       card of everything, with −1 / +1 buttons
 *   /tool <name> [n]            add n (default 1), creating the entry if new;
 *                               n may be negative: "/tool 線鋸 -1"
 *   /tool set <name> <n>        set the count to n
 *   /tool del <name>            remove the entry from the list
 *
 * Names may contain spaces ("/tool 電動 線鋸 2": the last number is the count)
 * and match case-insensitively, so repeats stack onto the same row. New names are
 * translated into the group's languages, and a translation matches too
 * ("/tool Jigsaw 1" stacks onto 線鋸 when that is its English name).
 */
export interface CounterSpec {
  /** Plugin name, also used as the table name, e.g. "tools". */
  name: string;
  /** The command, e.g. "tool"; `aliases` are accepted too. */
  command: string;
  aliases: string[];
  emoji: string;
  /** "工具", used in replies; `title` heads the card and help section. */
  noun: string;
  title: string;
  /** Example names for help and templates. */
  example: string;
  exampleQty: number;
  /** Old command names that now only point people to the new ones. */
  legacy?: string[];
}

const LEGACY_HINT = "📦 物品已分成兩類 Items are now split:\n🔧 /tool 工具（例：/tool 線鋸 1）\n🧱 /material 材料（例：/material 螺絲 100）";

export function counterPlugin(spec: CounterSpec): Plugin {
  const { name: table, command: cmd, emoji, noun, example: ex } = spec;
  const list: QuickItem = { label: `${emoji} ${spec.title}`, text: `/${cmd}` };
  const usage = (msg: string) => [text(msg)];

  return {
    name: spec.name,
    commands: [cmd, ...spec.aliases, ...(spec.legacy ?? [])],
    help: {
      title: `${emoji} ${spec.title}`,
      lines: [
        `/${cmd} ${ex} ${spec.exampleQty}　新增，或在原數量上加 ${spec.exampleQty}`,
        `/${cmd} ${ex} -1　減 1`,
        `/${cmd}　看清單，點 −1／+1 調整`,
        `/${cmd} set ${ex} 5　直接改成 5`,
      ],
    },
    templates: [
      { label: `新增／加減${noun}`, text: `/${cmd} ${noun}名稱 1`, note: "減少就打負數，例如 -1" },
      { label: `直接改${noun}數量`, text: `/${cmd} set ${noun}名稱 5` },
      { label: `移除${noun}`, text: `/${cmd} del ${noun}名稱` },
    ],
    quickReplies: [list],

    async onCommand(input, ctx) {
      if (spec.legacy?.includes(input.name)) return [text(LEGACY_HINT)];
      const [first, ...rest] = input.args;
      const db = ctx.storage;
      const by = (await ctx.displayName(input.userId)) ?? "";
      const at = new Date(input.event.timestamp).toISOString();
      const reply = (row: Row, before: number | undefined) => changed(spec, row, before);

      if (!first) {
        const all = await backfill(visible(await db.list(table)), "name", table, db, ctx);
        return [all.length ? card(spec, all) : text(`${emoji} 還沒有${noun}\n新增：/${cmd} ${ex} ${spec.exampleQty}`)];
      }

      const sub = first.toLowerCase();
      if (sub === "set") {
        const parsed = parseItem(rest.join(" "));
        if (!parsed.name || parsed.qty === undefined || parsed.qty < 0) return usage(`用法 Usage: /${cmd} set <名稱> <數量>\n例 e.g. /${cmd} set ${ex} 5`);
        const { row, before } = await upsert(db, table, ctx, parsed.name, () => parsed.qty!, by, at);
        return [reply(row, before)];
      }
      if (sub === "del" || sub === "remove") {
        const name = rest.join(" ").trim();
        const row = name ? find(visible(await db.list(table)), name) : undefined;
        if (!row) return usage(`找不到${noun}「${name}」 Not found`);
        await db.update(table, row.id, { removed: "1", updatedBy: by, updatedAt: at });
        return usage(`🗑 已移除 Removed：${withTranslations(row.name ?? "", row.i18n)}`);
      }

      const parsed = parseItem(input.rest);
      if (!parsed.name) return usage(`用法 Usage: /${cmd} <名稱> [數量]\n例 e.g. /${cmd} ${ex} 1、/${cmd} ${ex} -1`);
      const delta = parsed.qty ?? 1;
      const current = find(visible(await db.list(table)), parsed.name);
      const now = Number(current?.qty ?? 0);
      if (now + delta < 0) return usage(`⚠️ ${current?.name ?? parsed.name} 只剩 ${now}，不能減 ${-delta}\nOnly ${now} left.`);
      const { row, before } = await upsert(db, table, ctx, parsed.name, (n) => n + delta, by, at);
      return [reply(row, before)];
    },
  };
}

export const tools = counterPlugin({
  name: "tools",
  command: "tool",
  aliases: ["tools"],
  emoji: "🔧",
  noun: "工具",
  title: "工具 Tools",
  example: "線鋸",
  exampleQty: 1,
  legacy: ["item", "items"],
});

export const materials = counterPlugin({
  name: "materials",
  command: "material",
  aliases: ["materials", "mat"],
  emoji: "🧱",
  noun: "材料",
  title: "材料 Materials",
  example: "螺絲",
  exampleQty: 100,
});

/** Split "電動 線鋸 -2" into name "電動 線鋸" and qty -2; a missing number leaves qty undefined. */
export function parseItem(s: string): { name: string; qty?: number } {
  const m = s.trim().match(/^(.*\S)\s+([+-]?\d+)$/);
  if (m) return { name: m[1]!.trim(), qty: Number(m[2]) };
  return { name: s.trim() };
}

const key = (name: string) => name.trim().toLowerCase().replace(/\s+/g, " ");
const visible = (rows: Row[]) => rows.filter((r) => r.removed !== "1");

/** The row whose name, or one of its translations, is `name`; an exact name match wins. */
const find = (rows: Row[], name: string) =>
  rows.find((r) => key(r.name ?? "") === key(name)) ?? rows.find((r) => translationsOf(r.i18n).some((t) => key(t) === key(name)));

/** Apply `next` to the count, creating the row (or bringing back a removed one) if needed. */
async function upsert(db: Storage, table: string, ctx: PluginContext, name: string, next: (n: number) => number, by: string, at: string) {
  const rows = await db.list(table);
  const live = find(visible(rows), name);
  const before = live ? Number(live.qty ?? 0) : undefined;
  const qty = String(next(before ?? 0));
  if (live) return { row: (await db.update(table, live.id, { qty, updatedBy: by, updatedAt: at }))!, before };
  const old = find(rows, name); // removed earlier: reuse its row and id
  if (old) return { row: (await db.update(table, old.id, { qty, removed: "", updatedBy: by, updatedAt: at }))!, before };
  const i18n = await translateLabel(name, ctx);
  return { row: await db.append(table, { name, qty, updatedBy: by, updatedAt: at, ...(i18n ? { i18n } : {}) }), before };
}

function changed(spec: CounterSpec, row: Row, before: number | undefined): LineMessage {
  const label = withTranslations(row.name ?? "", row.i18n);
  const line = before === undefined ? `${spec.emoji} 新增 Added：${label} × ${row.qty}` : `${spec.emoji} ${label}：${before} → ${row.qty}`;
  const plus: QuickItem = { label: `➕ ${row.name}`.slice(0, 17) + " +1", text: `/${spec.command} ${row.name} +1` };
  const minus: QuickItem = { label: `➖ ${row.name}`.slice(0, 17) + " -1", text: `/${spec.command} ${row.name} -1` };
  return withQuickReply(text(line), [plus, ...(Number(row.qty) > 0 ? [minus] : [])]);
}

/** Rows shown in the card; longer lists say how many more there are. */
const MAX_CARD_ROWS = 15;

/** Everything as a Flex card: name and count, with −1 / +1 buttons on each row. */
function card(spec: CounterSpec, all: Row[]): LineMessage {
  const sorted = [...all].sort((a, b) => (a.name ?? "").localeCompare(b.name ?? "", "zh-Hant"));
  const shown = sorted.slice(0, MAX_CARD_ROWS);
  const button = (label: string, cmd: string, style: string) => ({
    type: "button",
    action: action({ label, text: cmd }),
    style,
    height: "sm",
    flex: 0,
  });
  const rows = shown.map((r) => ({
    type: "box",
    layout: "horizontal",
    spacing: "sm",
    alignItems: "center",
    contents: [
      {
        type: "box",
        layout: "vertical",
        flex: 4,
        contents: [
          { type: "text", text: r.name ?? "", size: "sm", weight: "bold", wrap: true },
          ...(flagged(r.i18n) ? [{ type: "text", text: flagged(r.i18n), size: "xxs", color: "#555555", wrap: true }] : []),
        ],
      },
      { type: "text", text: String(r.qty ?? 0), size: "lg", weight: "bold", align: "end", flex: 2, color: Number(r.qty) > 0 ? "#111111" : "#cc3333" },
      button("−1", `/${spec.command} ${r.name} -1`, "secondary"),
      button("+1", `/${spec.command} ${r.name} +1`, "primary"),
    ],
  }));
  const more = sorted.length - shown.length;
  const footer = more > 0 ? [{ type: "text", text: `還有 ${more} 項 +${more} more`, size: "xs", color: "#888888" }] : [];
  return {
    type: "flex",
    altText: `${spec.emoji} ${spec.title}\n${sorted.map((r) => `${withTranslations(r.name ?? "", r.i18n)} × ${r.qty}`).join("\n")}`.slice(0, 400),
    contents: {
      type: "bubble",
      body: {
        type: "box",
        layout: "vertical",
        spacing: "md",
        contents: [
          { type: "text", text: `${spec.emoji} ${spec.title} (${sorted.length})`, weight: "bold" },
          ...rows,
          ...footer,
          { type: "text", text: `改數量：/${spec.command} set 名稱 數量`, size: "xs", color: "#888888" },
        ],
      },
    },
  };
}
