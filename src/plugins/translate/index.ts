import type { Plugin } from "../../core/types";
import { text } from "../../core/types";
import { detectLang } from "./detect";
import { engines, type TranslateOptions } from "./engines";

/**
 * Settings (group.settings.translate):
 *   engine:    "google" | "deepl" | "claude"   (default "google")
 *   trigger:   "all"  – translate every text message (default)
 *              "command" – only messages sent as "/t <text>"
 *   showName:  prefix the translation with the sender's name (default true)
 *   minLength: skip messages shorter than this many characters (default 2)
 *   zhRatio:   share of Chinese needed to treat mixed text as Chinese (default 0.3)
 *   glossary:  fixed term translations, used by the "claude" engine
 *   model:     Claude model override
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
  commands: ["t", "translate"],

  async onMessage(input, ctx) {
    if ((ctx.settings.trigger ?? "all") !== "all") return;
    if (!(await isEnabled(ctx))) return;
    return run(input.text, input.userId, ctx, false);
  },

  async onCommand(input, ctx) {
    if (input.name !== "t") return toggle(input.args[0], ctx);
    if (!input.rest) return [text("用法 Usage: /t <要翻譯的文字 text to translate>")];
    return run(input.rest, input.userId, ctx, true);
  },
};

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
    return [text(on ? "🌐 自動翻譯：開啟 Auto-translate is ON" : "🌐 自動翻譯：關閉 Auto-translate is OFF")];
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

async function run(source: string, userId: string | undefined, ctx: Ctx, explicit: boolean) {
  try {
    return await translateText(source, userId, ctx);
  } catch (err) {
    console.error("translate failed", err);
    const now = Date.now();
    if (!explicit && now - (lastNotice.get(ctx.group.groupId) ?? 0) < NOTICE_WINDOW_MS) return;
    lastNotice.set(ctx.group.groupId, now);
    return [text("⚠️ 翻譯暫時無法使用，請稍後再試。\nTranslation is temporarily unavailable.")];
  }
}

async function translateText(source: string, userId: string | undefined, ctx: Ctx) {
  const s = ctx.settings;
  if (source.trim().length < Number(s.minLength ?? 2)) return;
  const lang = detectLang(source, Number(s.zhRatio ?? 0.3));
  if (lang === "skip") return;

  const engine = engines[String(s.engine ?? "google")];
  if (!engine) throw new Error(`unknown translate engine: ${String(s.engine)}`);
  const opts: TranslateOptions = { glossary: s.glossary as string | undefined, model: s.model as string | undefined };

  const out = await engine(source, lang === "zh" ? "en" : "zh-TW", ctx.env, opts);
  if (!out || out.trim() === source.trim()) return;

  const name = s.showName === false ? undefined : await ctx.displayName(userId);
  return [text(name ? `🌐 ${name}：${out}` : `🌐 ${out}`)];
}
