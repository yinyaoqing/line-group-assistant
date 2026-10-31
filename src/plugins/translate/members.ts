import { DEFAULT_LANGUAGES, isLangCode, LANGUAGES, type LangCode } from "../../../config/languages";
import type { PluginContext, QuickItem } from "../../core/types";
import type { Row, Storage } from "../../storage/types";

/**
 * Which language each member uses, in the "members" table: { userId, lang,
 * declared, seenAt }. A member's language is learnt from what they write, or
 * set with /lang (declared, which detection never overrides).
 *
 * With translate.targetMode = "members", messages are translated only into the
 * languages of members active in the last ACTIVE_DAYS, not every language the
 * group allows — fewer lines in the chat, and fewer characters to pay for.
 */
const TABLE = "members";
export const ACTIVE_DAYS = 30;
/** How often a member's last-seen time is written, at most. */
const SEEN_WRITE_MS = 24 * 3600 * 1000;

/** Members per group, re-read at most this often so busy chats do not read on every message. */
const CACHE_TTL_MS = 60 * 1000;
const cache = new Map<string, { rows: Row[]; at: number }>();

async function membersOf(storage: Storage, groupId: string): Promise<Row[]> {
  const hit = cache.get(groupId);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.rows;
  const rows = await storage.list(TABLE);
  cache.set(groupId, { rows, at: Date.now() });
  return rows;
}

const members = (ctx: PluginContext) => membersOf(ctx.storage, ctx.group.groupId);

export interface Member {
  userId: string;
  lang?: LangCode;
  /** Set by /lang or the settings page, rather than detected from what they wrote. */
  declared: boolean;
}

/** Every member with a known language: those who have written, or were set by an admin. */
export async function listMembers(storage: Storage, groupId: string): Promise<Member[]> {
  return (await membersOf(storage, groupId)).map((r) => ({ userId: r.userId!, lang: isLangCode(r.lang) ? r.lang : undefined, declared: r.declared === "1" }));
}

/**
 * Languages to translate into in "members" mode, or undefined to use all the
 * group's languages (the mode is off, or no member's language is known yet).
 */
export async function audience(ctx: PluginContext, now: number): Promise<LangCode[] | undefined> {
  if (ctx.settings.targetMode !== "members") return undefined;
  const langs = await memberLanguages(ctx, now);
  return langs.length ? langs : undefined;
}

/** Languages of members who declared one or were active in the last ACTIVE_DAYS. */
async function memberLanguages(ctx: PluginContext, now: number): Promise<LangCode[]> {
  const since = now - ACTIVE_DAYS * 24 * 3600 * 1000;
  const langs = (await members(ctx))
    .filter((r) => r.declared === "1" || new Date(r.seenAt ?? 0).getTime() >= since)
    .map((r) => r.lang)
    .filter(isLangCode);
  return [...new Set(langs)];
}

/**
 * The languages the group is known to use, for plugins other than translate:
 * members' languages when any are known, else the group's translate languages.
 */
export async function knownLanguages(ctx: PluginContext, now: number): Promise<LangCode[]> {
  const fromMembers = await memberLanguages(ctx, now);
  if (fromMembers.length) return fromMembers;
  const configured = (ctx.group.settings?.translate?.languages as unknown[] | undefined)?.filter(isLangCode) ?? [];
  return configured.length ? configured : DEFAULT_LANGUAGES;
}

/**
 * Note the language a member just wrote in. Writes only when it is new, when
 * it changed (unless the member declared one), or when last-seen is a day old.
 */
export async function noteLanguage(ctx: PluginContext, userId: string, lang: LangCode, now: number): Promise<void> {
  const rows = await members(ctx);
  const row = rows.find((r) => r.userId === userId);
  const seenAt = new Date(now).toISOString();
  if (!row) {
    rows.push(await ctx.storage.append(TABLE, { userId, lang, declared: "", seenAt }));
    return;
  }
  const changed = row.declared !== "1" && row.lang !== lang;
  if (!changed && now - new Date(row.seenAt ?? 0).getTime() < SEEN_WRITE_MS) return;
  Object.assign(row, await ctx.storage.update(TABLE, row.id, { ...(changed ? { lang } : {}), seenAt }));
}

/** Set a member's language (from /lang, an admin's /lang @member, or the settings page); it then wins over detection. */
export async function setMemberLanguage(storage: Storage, groupId: string, userId: string, lang: LangCode, now: number): Promise<void> {
  const rows = await membersOf(storage, groupId);
  const row = rows.find((r) => r.userId === userId);
  const fields = { lang, declared: "1", seenAt: new Date(now).toISOString() };
  if (row) Object.assign(row, await storage.update(TABLE, row.id, fields));
  else rows.push(await storage.append(TABLE, { userId, ...fields }));
}

export const declareLanguage = (ctx: PluginContext, userId: string, lang: LangCode, now: number) =>
  setMemberLanguage(ctx.storage, ctx.group.groupId, userId, lang, now);

/** "vi", "VI", "zh", "中文", "Tiếng Việt" → a language code, if it is one. */
export function parseLang(input: string): LangCode | undefined {
  const s = input.trim().toLowerCase();
  if (s === "zh" || s === "tw" || s === "zh-tw") return "zh-TW";
  if (isLangCode(s)) return s;
  return (Object.keys(LANGUAGES) as LangCode[]).find((c) => LANGUAGES[c].name.toLowerCase() === s);
}

/** One button per language the group uses, for /lang and the welcome message. */
export const languageButtons = (langs: LangCode[]): QuickItem[] =>
  langs.map((l) => ({ label: `${LANGUAGES[l].flag} ${LANGUAGES[l].name}`, text: `/lang ${l}` }));

/** Forget cached members, e.g. between tests. */
export const clearMemberCache = () => cache.clear();
