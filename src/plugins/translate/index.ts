import { DEFAULT_LANGUAGES, isLangCode, LANGUAGES, type LangCode } from "../../../config/languages";
import { DEFAULT_ENGINE, engineWeight, type Plan } from "../../../config/plans";
import type { CommandInput, Plugin, PluginContext } from "../../core/types";
import { text, withQuickReply } from "../../core/types";
import { detectScript } from "./detect";
import { audience, declareLanguage, languageButtons, listMembers, noteLanguage, parseLang } from "./members";
import { baseLang, engines, type TranslateOptions } from "./engines";

/**
 * Settings (group.settings.translate):
 *   engine:    "claude" (default, model claude-haiku-5-5) | "google" | "deepl"
 *   languages: codes to translate between, e.g. ["zh-TW", "en", "vi"] (default zh-TW ↔ en);
 *              each message is translated into all the others, limited by the plan
 *   trigger:   "all"  – translate every text message (default)
 *              "command" – only messages sent as "/t <text>"
 *   showName:  prefix the translation with the sender's name (default true)
 *   minLength: skip messages shorter than this many characters (default 2)
 *   zhRatio:   share of Chinese needed to treat mixed text as Chinese (default 0.3)
 *   glossary:  fixed term translations, used by the "claude" engine
 *   model:     Claude model override
 *   targetMode: "all" (default) or "members" – only translate into languages members actually use
 *   monthlyChars: per-group override of the plan's monthly character limit; 0 = unlimited
 *
 * Commands:
 *   /t <text>            translate this text
 *   /translate on|off    turn automatic translation on/off for the group
 *   /translate           show whether automatic translation is on
 * The on/off switch is stored in the "translate" table, so it survives redeploys
 * and can be edited in the spreadsheet. /t keeps working while it is off.
 *
 * Replies use the reply token, so translations do not use the monthly push quota.
 */
export const translate: Plugin = {
  name: "translate",
  commands: ["t", "translate", "lang"],
  help: {
    title: "🌐 翻譯 Translate",
    lines: ["直接聊天就會自動翻譯", "/translate　開／關自動翻譯", "/t 文字　只翻這一句", "/lang　看成員語言、選擇你的語言", "/lang @阿明 @Tuấn vi　管理員替成員設定語言"],
  },
  templates: [{ label: "翻譯一句話", text: "/t 要翻譯的文字" }],
  quickReplies: [{ label: "🌐 翻譯開關 Translate", text: "/translate" }],

  async onMessage(input, ctx) {
    if ((ctx.settings.trigger ?? "all") !== "all") return;
    if (!(await isEnabled(ctx))) return;
    return run(input.text, input.userId, ctx, false);
  },

  async onCommand(input, ctx) {
    if (input.name === "lang") return langCommand(input, ctx);
    if (input.name !== "t") return toggle(input.args[0], ctx);
    if (!input.rest) return [text("用法 Usage: /t <要翻譯的文字 text to translate>")];
    return run(input.rest, input.userId, ctx, true);
  },

  /** In "members" mode, ask newcomers their language, so translations reach them before they speak. */
  async onMemberJoined(_userIds, ctx) {
    if (ctx.settings.targetMode !== "members") return;
    const langs = groupLanguages(ctx.settings, ctx.plan);
    return [withQuickReply(text("👋 歡迎！請點下方按鈕選擇你的語言\nWelcome! Tap your language below.\nChào mừng! Chọn ngôn ngữ của bạn."), languageButtons(langs))];
  },
};

/**
 * /lang               who is set to which language, then the buttons
 * /lang vi            set the sender's language
 * /lang @A @B vi      admins: set other members' languages (LINE's @ supplies their IDs;
 *                     the language is the last word, so names with spaces are fine)
 */
async function langCommand(input: CommandInput, ctx: Ctx) {
  const { userId, event } = input;
  const langs = groupLanguages(ctx.settings, ctx.plan);
  const choose = () => [withQuickReply(text("🌐 請選擇你的語言 Choose your language"), languageButtons(langs))];
  const label = (l: LangCode) => `${LANGUAGES[l].flag} ${LANGUAGES[l].name}`;
  const name = async (u: string) => (await ctx.displayName(u)) ?? u.slice(0, 8);
  const words = input.args.filter((w) => !/^[@＠]/.test(w));
  if (!words.length || !userId) {
    const known = await listMembers(ctx.storage, ctx.group.groupId);
    if (!known.length) return choose();
    const lines = await Promise.all(known.map(async (m) => `・${await name(m.userId)}：${m.lang ? label(m.lang) : "？"}${m.declared ? "" : "（自動 auto）"}`));
    return [withQuickReply(text(`🌐 成員語言 Member languages\n${lines.join("\n")}\n\n點下方按鈕選你的語言 Tap yours below\n管理員替人設定 Admins: /lang @成員 vi`), languageButtons(langs))];
  }
  const lang = parseLang(words[words.length - 1]!);
  if (!lang || !langs.includes(lang)) return choose();
  const mentioned = (event.message?.mention?.mentionees ?? []).filter((m) => !m.isSelf && m.userId).map((m) => m.userId!);
  if (mentioned.length) {
    if (!(await ctx.isAdmin(userId))) return [text("🔒 只有管理員可以替別人設定語言。\nOnly admins can set other members' languages.")];
    const names: string[] = [];
    for (const u of mentioned) {
      await declareLanguage(ctx, u, lang, event.timestamp);
      names.push(await name(u));
    }
    return [text(`✅ ${names.join("、")} 的語言 Language：${label(lang)}`)];
  }
  await declareLanguage(ctx, userId, lang, event.timestamp);
  return [text(`✅ ${await name(userId)} 的語言 Language：${label(lang)}`)];
}

type Ctx = Parameters<NonNullable<Plugin["onMessage"]>>[1];

const STATE_TABLE = "translate";
const SWITCH: Record<string, boolean> = { on: true, off: false };

/** Re-read the switch at most this often per group, to keep Sheets calls off the hot path. */
const STATE_TTL_MS = 60 * 1000;
const stateCache = new Map<string, { enabled: boolean; at: number }>();

async function isEnabled(ctx: Ctx): Promise<boolean> {
  const hit = stateCache.get(ctx.group.groupId);
  if (hit && Date.now() - hit.at < STATE_TTL_MS) return hit.enabled;
  const [row] = await ctx.storage.list(STATE_TABLE);
  const enabled = row?.enabled !== "false";
  stateCache.set(ctx.group.groupId, { enabled, at: Date.now() });
  return enabled;
}

async function toggle(arg: string | undefined, ctx: Ctx) {
  const want = arg === undefined ? undefined : SWITCH[arg.toLowerCase()];
  if (arg !== undefined && want === undefined) return [text("用法 Usage: /translate on|off")];
  if (want === undefined) {
    const on = await isEnabled(ctx);
    const flip = on ? { label: "🔕 關閉翻譯 Off", text: "/translate off" } : { label: "🌐 開啟翻譯 On", text: "/translate on" };
    return [withQuickReply(text(on ? "🌐 自動翻譯：開啟 Auto-translate is ON" : "🌐 自動翻譯：關閉 Auto-translate is OFF"), [flip])];
  }
  const [row] = await ctx.storage.list(STATE_TABLE);
  const value = String(want);
  if (row) await ctx.storage.update(STATE_TABLE, row.id, { enabled: value });
  else await ctx.storage.append(STATE_TABLE, { enabled: value });
  stateCache.set(ctx.group.groupId, { enabled: want, at: Date.now() });
  return [text(want ? "🌐 已開啟自動翻譯 Auto-translate ON" : "🔕 已關閉自動翻譯，仍可用 /t 翻譯\nAuto-translate OFF (/t still works)")];
}

/** Warn the group at most once per window when automatic translation keeps failing. */
const NOTICE_WINDOW_MS = 10 * 60 * 1000;
const lastNotice = new Map<string, number>();

/** Characters sent to the translation engine this month; what the quota and billing count. */
export const USAGE_METRIC = "translate_chars";

export class QuotaExceeded extends Error {}

async function run(source: string, userId: string | undefined, ctx: Ctx, explicit: boolean) {
  try {
    return await translateText(source, userId, ctx);
  } catch (err) {
    const quota = err instanceof QuotaExceeded;
    if (!quota) console.error("translate failed", err);
    const now = Date.now();
    if (!explicit && now - (lastNotice.get(ctx.group.groupId) ?? 0) < NOTICE_WINDOW_MS) return;
    lastNotice.set(ctx.group.groupId, now);
    return [
      text(
        quota
          ? "📊 本月翻譯額度已用完，下個月會自動恢復。\nThis month's translation quota is used up."
          : "⚠️ 翻譯暫時無法使用，請稍後再試。\nTranslation is temporarily unavailable.",
      ),
    ];
  }
}

/**
 * The group's languages, limited to what its plan allows. Fewer than two
 * usable languages falls back to Chinese ↔ English.
 */
export function groupLanguages(settings: Record<string, unknown>, plan: Plan): LangCode[] {
  const wanted = Array.isArray(settings.languages) ? settings.languages.filter(isLangCode) : DEFAULT_LANGUAGES;
  const allowed = [...new Set(wanted)].filter((l) => plan.languages.includes(l));
  return allowed.length >= 2 ? allowed : DEFAULT_LANGUAGES;
}

/** The monthly character limit: a per-group override, else the plan's. 0 = unlimited. */
export const monthlyLimit = (settings: Record<string, unknown>, plan: Plan) =>
  typeof settings.monthlyChars === "number" ? settings.monthlyChars : plan.monthlyChars;

/**
 * Translate a message into every other language of the group. The source
 * language comes from the script when that is enough (Chinese, Japanese, Thai,
 * Vietnamese, or the group's only Latin-script language); otherwise the first
 * engine call reports it and the rest skip that language.
 */
/** What translation needs from a plugin context; tasks and items pass the group's translate settings. */
export interface TranslateCtx {
  settings: Record<string, unknown>;
  plan: Plan;
  env: PluginContext["env"];
  usage: PluginContext["usage"];
  /** Top-up characters of a per-user account, spent after the monthly allowance. */
  bonus?: PluginContext["bonus"];
  /** Only translate into these languages (the members' languages); undefined = all of the group's. */
  audience?: LangCode[];
}

/**
 * Translate `source` into the group's other languages (or only `only`, when
 * given). Returns the source language when known and one result per language.
 * Throws QuotaExceeded when the month's characters are used up.
 */
export async function translateCore(source: string, t: TranslateCtx, only?: LangCode[]): Promise<{ from?: LangCode; outs: { target: LangCode; text: string }[] }> {
  const s = t.settings;
  const script = detectScript(source, Number(s.zhRatio ?? 0.3));
  if (script === "skip") return { outs: [] };

  const langs = groupLanguages(s, t.plan);
  const latin = langs.filter((l) => LANGUAGES[l].latin);
  let from: LangCode | undefined = script !== "latin" ? script : latin.length === 1 ? latin[0] : undefined;
  let targets = langs.filter((l) => l !== from && (!only || only.includes(l)) && (!t.audience || t.audience.includes(l)));
  if (!targets.length) return { from, outs: [] };

  const engine = engines[String(s.engine ?? DEFAULT_ENGINE.engine)];
  if (!engine) throw new Error(`unknown translate engine: ${String(s.engine)}`);
  const opts: TranslateOptions = {
    glossary: s.glossary as string | undefined,
    model: s.model as string | undefined,
    tone: s.tone as string | undefined,
    toneNote: s.toneNote as string | undefined,
  };

  // Accounts (per-user plans) share one allowance across their groups, so a group's
  // own override does not apply; past the allowance, top-up characters are spent.
  const limit = t.bonus ? t.plan.monthlyChars : monthlyLimit(s, t.plan);
  const usedBefore = await t.usage.get(USAGE_METRIC);
  if (limit > 0) {
    // Check what this message will cost before calling any engine, so the last few
    // characters of an allowance cannot pay for a long message in seven languages.
    const estimate = Math.ceil(source.length * targets.length * engineWeight(s));
    const left = Math.max(0, limit - usedBefore) + (t.bonus ? await t.bonus.get() : 0);
    if (estimate > left) throw new QuotaExceeded();
  }

  let calls = 0; // every engine call is billed for the full text
  const call = async (target: LangCode) => {
    calls++;
    const r = await engine(source, target, t.env, opts);
    return { target, ...(typeof r === "string" ? { text: r } : r) };
  };
  const results: { target: LangCode; text: string; detected?: string }[] = [];
  if (!from) {
    // Unknown Latin-script source: let the first call identify it.
    const first = await call(targets[0]!);
    const detected = first.detected ? baseLang(first.detected) : undefined;
    from = langs.find((l) => baseLang(l) === detected);
    targets = targets.slice(1).filter((l) => baseLang(l) !== detected);
    if (baseLang(first.target) !== detected) results.push(first);
  }
  results.push(...(await Promise.all(targets.map(call))));
  // Costlier engines count for more allowance characters (config/plans.ts ENGINE_WEIGHT).
  const charged = Math.ceil(source.length * calls * engineWeight(s));
  await t.usage.add(USAGE_METRIC, charged);
  if (t.bonus && limit > 0) {
    const overflow = Math.max(0, usedBefore + charged - limit) - Math.max(0, usedBefore - limit);
    if (overflow > 0) await t.bonus.consume(overflow);
  }

  return { from, outs: results.filter((r) => r.text && r.text.trim() !== source.trim()).map(({ target, text }) => ({ target, text })) };
}

async function translateText(source: string, userId: string | undefined, ctx: Ctx) {
  const s = ctx.settings;
  if (source.trim().length < Number(s.minLength ?? 2)) return;
  const now = Date.now();
  const { from, outs } = await translateCore(source, { ...ctx, audience: await audience(ctx, now) });
  // Learn the writer's language, for "translate only into members' languages".
  if (from && userId) await noteLanguage(ctx, userId, from, now).catch((err) => console.error("noteLanguage failed", err));
  if (!outs.length) return;

  const name = s.showName === false ? undefined : await ctx.displayName(userId);
  if (outs.length === 1) return [text(name ? `🌐 ${name}：${outs[0]!.text}` : `🌐 ${outs[0]!.text}`)];
  const lines = outs.map((r) => `${LANGUAGES[r.target].flag} ${r.text}`);
  return [text([`🌐 ${name ?? ""}`.trimEnd(), ...lines].join("\n"))];
}
