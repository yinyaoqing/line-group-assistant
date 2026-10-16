/** Languages a group can translate between. Codes follow Google Translate. */
export const LANGUAGES = {
  "zh-TW": { name: "中文", flag: "🇹🇼", latin: false },
  en: { name: "English", flag: "🇺🇸", latin: true },
  vi: { name: "Tiếng Việt", flag: "🇻🇳", latin: true },
  id: { name: "Bahasa Indonesia", flag: "🇮🇩", latin: true },
  th: { name: "ภาษาไทย", flag: "🇹🇭", latin: false },
  tl: { name: "Filipino", flag: "🇵🇭", latin: true },
  ja: { name: "日本語", flag: "🇯🇵", latin: false },
} as const;

export type LangCode = keyof typeof LANGUAGES;

export const LANG_CODES = Object.keys(LANGUAGES) as LangCode[];

export const isLangCode = (s: unknown): s is LangCode => typeof s === "string" && s in LANGUAGES;

/** What a group translates between when its settings name no languages. */
export const DEFAULT_LANGUAGES: LangCode[] = ["zh-TW", "en"];
