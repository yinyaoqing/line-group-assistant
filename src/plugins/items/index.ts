import type { LineMessage, Plugin, PluginContext, QuickItem } from "../../core/types";
import { action, text, withQuickReply } from "../../core/types";
import type { Row, Storage } from "../../storage/types";
import { backfill, flagged, translateLabel, translationsOf, withTranslations } from "../translate/terms";

/**
 * Item counts (tools, materials, stock), stored in the "items" table.
 *
 *   /item                       card of all items, with −1 / +1 buttons
 *   /item <name> [n]            add n (default 1) to the item, creating it if new;
 *                               n may be negative: "/item 線鋸 -1"
 *   /item set <name> <n>        set the count to n
 *   /item del <name>            remove the item from the list
 *
 * Names may contain spaces ("/item 電動 線鋸 2": the last number is the count)
 * and match case-insensitively, so repeats stack onto the same row. New names are
 * translated into the group's languages, and a translation matches too
 * ("/item Jigsaw 1" stacks onto 線鋸 when that is its English name).
 */
const TABLE = "items";

const LIST: QuickItem = { label: "📦 物品 Items", text: "/item" };

export const items: Plugin = {
  name: "items",
  commands: ["item", "items"],
  help: {
    title: "📦 物品 Items",
    lines: ["/item 線鋸 1　新增，或在原數量上加 1", "/item 線鋸 -1　減 1", "/item　看清單，點 −1／+1 調整", "/item set 線鋸 5　直接改成 5"],
  },
  templates: [
    { label: "新增／加減物品", text: "/item 物品名稱 1", note: "減少就打負數，例如 -1" },
    { label: "直接改數量", text: "/item set 物品名稱 5" },
    { label: "移除物品", text: "/item del 物品名稱" },
  ],
  quickReplies: [LIST],

  async onCommand(input, ctx) {
    const [first, ...rest] = input.args;
    const db = ctx.storage;
    const by = (await ctx.displayName(input.userId)) ?? "";
    const at = new Date(input.event.timestamp).toISOString();

    if (!first) {
      const all = await backfill(visible(await db.list(TABLE)), "name", TABLE, db, ctx);
      return [all.length ? itemList(all) : text("📦 還沒有物品 No items yet\n新增：/item 線鋸 1")];
    }

    const sub = first.toLowerCase();
    if (sub === "set") {
      const parsed = parseItem(rest.join(" "));
      if (!parsed.name || parsed.qty === undefined || parsed.qty < 0) return [text("用法 Usage: /item set <名稱> <數量>\n例 e.g. /item set 線鋸 5")];
      const { row, before } = await upsert(db, ctx, parsed.name, () => parsed.qty!, by, at);
      return [changed(row, before)];
    }
    if (sub === "del" || sub === "remove") {
      const name = rest.join(" ").trim();
      const row = name ? find(visible(await db.list(TABLE)), name) : undefined;
      if (!row) return [text(`找不到物品「${name}」 Item not found`)];
      await db.update(TABLE, row.id, { removed: "1", updatedBy: by, updatedAt: at });
      return [text(`🗑 已移除 Removed：${withTranslations(row.name ?? "", row.i18n)}`)];
    }

    const parsed = parseItem(input.rest);
    if (!parsed.name) return [text("用法 Usage: /item <名稱> [數量]\n例 e.g. /item 線鋸 1、/item 線鋸 -1")];
    const delta = parsed.qty ?? 1;
    const current = find(visible(await db.list(TABLE)), parsed.name);
    const now = Number(current?.qty ?? 0);
    if (now + delta < 0) return [text(`⚠️ ${current?.name ?? parsed.name} 只剩 ${now}，不能減 ${-delta}\nOnly ${now} left.`)];
    const { row, before } = await upsert(db, ctx, parsed.name, (n) => n + delta, by, at);
    return [changed(row, before)];
  },
};

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

/** Apply `next` to the item's count, creating the row (or bringing back a removed one) if needed. */
async function upsert(db: Storage, ctx: PluginContext, name: string, next: (n: number) => number, by: string, at: string) {
  const rows = await db.list(TABLE);
  const live = find(visible(rows), name);
  const before = live ? Number(live.qty ?? 0) : undefined;
  const qty = String(next(before ?? 0));
  if (live) return { row: (await db.update(TABLE, live.id, { qty, updatedBy: by, updatedAt: at }))!, before };
  const old = find(rows, name); // removed earlier: reuse its row and id
  if (old) return { row: (await db.update(TABLE, old.id, { qty, removed: "", updatedBy: by, updatedAt: at }))!, before };
  const i18n = await translateLabel(name, ctx);
  return { row: await db.append(TABLE, { name, qty, updatedBy: by, updatedAt: at, ...(i18n ? { i18n } : {}) }), before };
}

const plusOf = (r: Row, n = 1): QuickItem => ({ label: `➕ ${r.name}`.slice(0, 17) + ` +${n}`, text: `/item ${r.name} +${n}` });
const minusOf = (r: Row): QuickItem => ({ label: `➖ ${r.name}`.slice(0, 17) + " -1", text: `/item ${r.name} -1` });

function changed(row: Row, before: number | undefined): LineMessage {
  const label = withTranslations(row.name ?? "", row.i18n);
  const line = before === undefined ? `📦 新增 Added：${label} × ${row.qty}` : `📦 ${label}：${before} → ${row.qty}`;
  return withQuickReply(text(line), [plusOf(row), ...(Number(row.qty) > 0 ? [minusOf(row)] : [])]);
}

/** Rows shown in the card; longer lists say how many more there are. */
const MAX_CARD_ROWS = 15;

/** All items as a Flex card: name and count, with −1 / +1 buttons on each row. */
function itemList(all: Row[]): LineMessage {
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
      button("−1", `/item ${r.name} -1`, "secondary"),
      button("+1", `/item ${r.name} +1`, "primary"),
    ],
  }));
  const more = sorted.length - shown.length;
  const footer = more > 0 ? [{ type: "text", text: `還有 ${more} 項 +${more} more`, size: "xs", color: "#888888" }] : [];
  return {
    type: "flex",
    altText: `📦 物品 Items\n${sorted.map((r) => `${withTranslations(r.name ?? "", r.i18n)} × ${r.qty}`).join("\n")}`.slice(0, 400),
    contents: {
      type: "bubble",
      body: {
        type: "box",
        layout: "vertical",
        spacing: "md",
        contents: [
          { type: "text", text: `📦 物品數量 Items (${sorted.length})`, weight: "bold" },
          ...rows,
          ...footer,
          { type: "text", text: "改數量：/item set 名稱 數量", size: "xs", color: "#888888" },
        ],
      },
    },
  };
}
