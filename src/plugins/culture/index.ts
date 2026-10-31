import { DAILY_CRON } from "../../../config/crons";
import { FESTIVALS, TIPS, type Festival } from "../../../config/culture";
import { LANGUAGES, LANG_CODES, type LangCode } from "../../../config/languages";
import type { Plugin, PluginContext, QuickItem } from "../../core/types";
import { text } from "../../core/types";
import { knownLanguages, parseLang } from "../translate/members";

/**
 * Festivals and customs of the cultures in the group (config/culture.ts), so
 * the Chinese-speaking side knows when a colleague's big day is coming, what
 * it means, and what to say.
 *
 *   /culture            the next two months for the languages members use
 *   /culture id         one culture's whole year, with its everyday etiquette
 *
 * Every day the cron looks `leadDays` ahead and reminds the group once per
 * festival, through ctx.push (free by default: it rides on the next reply).
 * A festival starting today that was never announced is announced today.
 *
 * Settings (group.settings.culture):
 *   leadDays: 2   – how many days ahead to remind
 */
const SENT = "culture_sent";
const LOOKAHEAD_DAYS = 60;
export const DEFAULT_LEAD_DAYS = 2;
const TAIPEI_OFFSET_MS = 8 * 3600 * 1000;
const DAY_MS = 24 * 3600 * 1000;

const LIST: QuickItem = { label: "🎎 節日 Festivals", text: "/culture" };

export interface Occurrence {
  lang: LangCode;
  festival: Festival;
  /** Start date "YYYY-MM-DD". */
  day: string;
  /** Days from today to the start; negative while it is under way. */
  inDays: number;
}

/** The calendar day in Taipei, "YYYY-MM-DD". */
export const dayInTaipei = (ms: number) => new Date(ms + TAIPEI_OFFSET_MS).toISOString().slice(0, 10);
const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);

/**
 * Festivals of these languages that start within `withinDays` of `today`, or
 * are still under way; soonest first.
 */
export function upcoming(langs: LangCode[], today: string, withinDays: number): Occurrence[] {
  const year = Number(today.slice(0, 4));
  const out: Occurrence[] = [];
  for (const lang of langs) {
    for (const festival of FESTIVALS[lang] ?? []) {
      const starts = festival.fixed ? [`${year}-${festival.fixed}`, `${year + 1}-${festival.fixed}`] : (festival.dates ?? []);
      for (const day of starts) {
        const inDays = daysBetween(today, day);
        const lastDay = inDays + (festival.days ?? 1) - 1;
        if (lastDay >= 0 && inDays <= withinDays) out.push({ lang, festival, day, inDays });
      }
    }
  }
  return out.sort((a, b) => a.inDays - b.inDays || a.lang.localeCompare(b.lang));
}

/** "3/20" */
const md = (day: string) => `${Number(day.slice(5, 7))}/${Number(day.slice(8, 10))}`;
const endOf = (o: Occurrence) => md(new Date(Date.parse(`${o.day}T00:00:00Z`) + ((o.festival.days ?? 1) - 1) * DAY_MS).toISOString().slice(0, 10));

/** "2 天後（3/20）", "今天", or "進行中（到 3/19）". */
export function when(o: Occurrence): string {
  if (o.inDays < 0) return `進行中（到 ${endOf(o)}）`;
  if (o.inDays === 0) return "今天";
  return `${o.inDays} 天後（${md(o.day)}）`;
}

const culture = (lang: LangCode) => (lang === "zh-TW" ? "台灣" : lang === "en" ? "英語國家" : LANGUAGES[lang].name);

function describe(o: Occurrence, { full }: { full: boolean }): string {
  const f = o.festival;
  const lines = [`・${when(o)} ${f.name} ${f.local}`];
  if (full) lines.push(`　${f.note}`);
  if (f.greeting) lines.push(`　可以這樣說：${f.greeting}`);
  if (full && f.approx) lines.push("　（依月亮觀測，日期可能差一天）");
  return lines.join("\n");
}

/** One section per language: flag, name, its festivals, then its etiquette line. */
function sections(items: Occurrence[], langs: LangCode[], full: boolean): string {
  return langs
    .map((lang) => {
      const mine = items.filter((o) => o.lang === lang);
      if (!mine.length && !full) return "";
      const head = `${LANGUAGES[lang].flag} ${culture(lang)}`;
      const body = mine.length ? mine.map((o) => describe(o, { full })).join("\n") : "・接下來沒有節日";
      const tip = TIPS[lang] ? `　💡 ${TIPS[lang]}` : "";
      return [head, body, tip].filter(Boolean).join("\n");
    })
    .filter(Boolean)
    .join("\n\n");
}

const leadDaysOf = (ctx: PluginContext) => {
  const n = Number(ctx.settings.leadDays);
  return Number.isInteger(n) && n >= 0 && n <= 14 ? n : DEFAULT_LEAD_DAYS;
};

export const cultureFestivals: Plugin = {
  name: "culture",
  commands: ["culture", "festival"],
  help: {
    title: "🎎 節日與習俗 Festivals",
    lines: ["/culture　看群組成員接下來兩個月的節日和習俗", "/culture id　看某個文化一整年的節日（id、vi、th、tl、ja、en、zh）", "節日前 2 天會自動提醒，並附上可以用的問候語"],
  },
  templates: [{ label: "看某個文化的節日", text: "/culture vi", note: "id 印尼、vi 越南、th 泰國、tl 菲律賓、ja 日本、en 英語、zh 台灣" }],
  quickReplies: [LIST],

  async onCommand(input, ctx) {
    const today = dayInTaipei(input.event.timestamp);
    const asked = input.args[0] ? parseLang(input.args[0]) : undefined;
    if (input.args[0] && !asked) return [text(`不認識這個語言 Unknown language: ${input.args[0]}\n可用 Available: ${LANG_CODES.join("、")}`)];
    if (asked) {
      const items = upcoming([asked], today, 366);
      return [text(`🎎 ${culture(asked)}的節日 Festivals\n\n${sections(items, [asked], true)}`)];
    }
    const langs = await knownLanguages(ctx, input.event.timestamp);
    const items = upcoming(langs, today, LOOKAHEAD_DAYS);
    const body = items.length ? sections(items, langs, true) : `接下來 ${LOOKAHEAD_DAYS} 天沒有節日 No festivals in the next ${LOOKAHEAD_DAYS} days`;
    return [text(`🎎 接下來兩個月的節日 Festivals in the next two months\n\n${body}\n\n看某個文化一整年：/culture id`)];
  },

  async onSchedule(cron, ctx) {
    if (cron !== DAILY_CRON) return;
    const now = Date.now();
    const today = dayInTaipei(now);
    const lead = leadDaysOf(ctx);
    const langs = await knownLanguages(ctx, now);
    // Due: exactly leadDays ahead, or nearer than that and never announced (plugin turned on late).
    const due = upcoming(langs, today, lead).filter((o) => o.inDays >= 0);
    if (!due.length) return;
    const sent = new Set((await ctx.storage.list(SENT)).map((r) => r.key));
    const fresh = due.filter((o) => !sent.has(`${o.lang}:${o.day}`));
    if (!fresh.length) return;
    for (const o of fresh) await ctx.storage.append(SENT, { key: `${o.lang}:${o.day}`, sentAt: new Date(now).toISOString() });
    const lines = fresh.map((o) => `${LANGUAGES[o.lang].flag} ${when(o)}是${culture(o.lang)}的 ${o.festival.name} ${o.festival.local}\n${describe(o, { full: true }).split("\n").slice(1).join("\n")}`);
    await ctx.push([text(`🎎 節日提醒 Festival reminder\n\n${lines.join("\n\n")}`)]);
  },
};
