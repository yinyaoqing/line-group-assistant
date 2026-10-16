import { LANGUAGES, isLangCode, type LangCode } from "../../../config/languages";
import type { PluginContext } from "../../core/types";
import type { Row, Storage } from "../../storage/types";
import { groupLanguages, translateCore } from ".";

/**
 * Translations of a short label (a task title, an item name), stored on the row
 * as JSON in the "i18n" field: { "_src": "zh-TW", "en": "Buy breakfast", … }.
 * Tasks and items use the group's translate settings and quota; nothing is
 * translated when the group has the translate plugin off.
 */
export type I18n = Partial<Record<LangCode, string>> & {
  _src?: string;
  /** Languages whose translation came back identical (names, brands), so they are not retried. */
  _same?: LangCode[];
};

export function readI18n(raw: string | undefined): I18n {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === "object" ? (v as I18n) : {};
  } catch {
    return {};
  }
}

/** The translations as a list, in the group's language order where known. */
export function translationsOf(raw: string | undefined): string[] {
  const i18n = readI18n(raw);
  return (Object.keys(i18n) as string[]).filter((k) => isLangCode(k) && i18n[k as LangCode]).map((k) => i18n[k as LangCode]!);
}

/** "買早餐 / Buy breakfast / Mua bữa sáng". */
export const withTranslations = (label: string, raw: string | undefined) => [label, ...translationsOf(raw)].join(" / ");

/** The same with flags, one per line, for card subtitles: "🇺🇸 Buy breakfast  🇻🇳 Mua bữa sáng". */
export function flagged(raw: string | undefined): string {
  const i18n = readI18n(raw);
  return (Object.keys(i18n) as string[])
    .filter((k): k is LangCode => isLangCode(k) && !!i18n[k])
    .map((k) => `${LANGUAGES[k].flag} ${i18n[k]}`)
    .join("  ");
}

const translateCtx = (ctx: PluginContext) => ({
  settings: ctx.group.settings?.translate ?? {},
  plan: ctx.plan,
  env: ctx.env,
  usage: ctx.usage,
});

/** Languages the group wants that this row's i18n still lacks (none if translation is off). */
function missing(ctx: PluginContext, i18n: I18n): LangCode[] {
  if (!ctx.group.plugins.includes("translate")) return [];
  const langs = groupLanguages(ctx.group.settings?.translate ?? {}, ctx.plan);
  return langs.filter((l) => l !== i18n._src && !i18n[l] && !i18n._same?.includes(l));
}

/**
 * Translate `label` into the group's languages, merging into `existing`.
 * Returns the new i18n JSON, or undefined when there is nothing to add or the
 * translation failed (a label still works untranslated).
 */
export async function translateLabel(label: string, ctx: PluginContext, existing?: string): Promise<string | undefined> {
  const i18n = readI18n(existing);
  const need = missing(ctx, i18n);
  if (!need.length || !label.trim()) return undefined;
  try {
    const { from, outs } = await translateCore(label, translateCtx(ctx), need);
    const next: I18n = { ...i18n, ...(from || i18n._src ? { _src: i18n._src ?? from } : {}) };
    for (const o of outs) if (o.target !== next._src) next[o.target] = o.text;
    // Languages asked for but not returned translated to the label itself: remember them.
    const same = need.filter((l) => l !== next._src && !outs.some((o) => o.target === l));
    if (same.length) next._same = [...new Set([...(i18n._same ?? []), ...same])];
    return JSON.stringify(next);
  } catch (err) {
    console.error("label translation failed", err);
    return undefined;
  }
}

/** Rows translated on the fly per request when listed; the rest wait for the next listing. */
export const BACKFILL_PER_REQUEST = 10;

/**
 * Fill in missing translations for rows created before translation existed or
 * before a language was added. Updates storage and returns the refreshed rows.
 */
export async function backfill(rows: Row[], field: string, table: string, db: Storage, ctx: PluginContext): Promise<Row[]> {
  const todo = rows.filter((r) => r[field] && missing(ctx, readI18n(r.i18n)).length).slice(0, BACKFILL_PER_REQUEST);
  if (!todo.length) return rows;
  const updated = new Map<string, Row>();
  await Promise.all(
    todo.map(async (r) => {
      const i18n = await translateLabel(r[field]!, ctx, r.i18n);
      if (i18n) updated.set(r.id, (await db.update(table, r.id, { i18n })) ?? { ...r, i18n });
    }),
  );
  return rows.map((r) => updated.get(r.id) ?? r);
}
