import type { LangCode } from "../../../config/languages";
import type { Env } from "../../core/types";

export type Target = LangCode;

export interface TranslateOptions {
  /** Terms to keep or translate a fixed way, e.g. "Zace = Zace; 收頭樑 = trimmer beam". Used by "claude". */
  glossary?: string;
  /** Override the Claude model. */
  model?: string;
}

/** A translation, plus the source language when the engine reports it (e.g. "en", "zh-TW"). */
export type Translation = string | { text: string; detected?: string };

export type Engine = (text: string, target: Target, env: Env, opts: TranslateOptions, f?: typeof fetch) => Promise<Translation>;

export const google: Engine = async (text, target, env, _opts, f = fetch) => {
  if (!env.GOOGLE_TRANSLATE_API_KEY) throw new Error("GOOGLE_TRANSLATE_API_KEY not set");
  const res = await f(`https://translation.googleapis.com/language/translate/v2?key=${env.GOOGLE_TRANSLATE_API_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ q: text, target, format: "text" }),
  });
  if (!res.ok) throw new Error(`Google Translate ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as { data: { translations: { translatedText: string; detectedSourceLanguage?: string }[] } };
  const t = data.data.translations[0];
  return { text: t?.translatedText ?? "", detected: t?.detectedSourceLanguage };
};

/** DeepL target codes; languages DeepL does not offer are left out and rejected. */
const DEEPL_TARGET: Partial<Record<LangCode, string>> = { en: "EN-US", "zh-TW": "ZH-HANT", ja: "JA", id: "ID" };

export const deepl: Engine = async (text, target, env, _opts, f = fetch) => {
  const key = env.DEEPL_API_KEY;
  if (!key) throw new Error("DEEPL_API_KEY not set");
  const lang = DEEPL_TARGET[target];
  if (!lang) throw new Error(`DeepL does not support ${target}`);
  // Free-plan keys end in ":fx" and use a different host.
  const host = key.endsWith(":fx") ? "https://api-free.deepl.com" : "https://api.deepl.com";
  const res = await f(`${host}/v2/translate`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `DeepL-Auth-Key ${key}` },
    body: JSON.stringify({ text: [text], target_lang: lang }),
  });
  if (!res.ok) throw new Error(`DeepL ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as { translations: { text: string; detected_source_language?: string }[] };
  const t = data.translations[0];
  return { text: t?.text ?? "", detected: t?.detected_source_language?.toLowerCase() };
};

const CLAUDE_LANG: Record<LangCode, string> = {
  "zh-TW": "Traditional Chinese as used in Taiwan",
  en: "natural English",
  vi: "Vietnamese",
  id: "Indonesian",
  th: "Thai",
  tl: "Filipino (Tagalog)",
  ja: "Japanese",
};

export const claude: Engine = async (text, target, env, opts, f = fetch) => {
  if (!env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY not set");
  const system = [
    `Translate the user's chat message into ${CLAUDE_LANG[target]}.`,
    "Keep the tone, names, numbers and emoji. Output only the translation, with no notes or quotes.",
    "If the message is already in that language, output it unchanged.",
    opts.glossary ? `Glossary (always follow): ${opts.glossary}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  const res = await f("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: opts.model ?? "claude-haiku-5-5",
      max_tokens: 1024,
      system,
      messages: [{ role: "user", content: text }],
    }),
  });
  if (!res.ok) throw new Error(`Claude ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as { content: { type: string; text?: string }[] };
  return data.content.filter((c) => c.type === "text").map((c) => c.text).join("").trim();
};

export const engines: Record<string, Engine> = { google, deepl, claude };

/** Engine-reported codes ("zh-TW", "zh", "fil", "EN") reduced to the base language for comparison. */
export const baseLang = (code: string) => {
  const c = code.toLowerCase();
  return c === "fil" ? "tl" : c.split("-")[0]!;
};
