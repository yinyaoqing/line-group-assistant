import type { LangCode } from "../../../config/languages";

export type Lang = "zh" | "en" | "skip";

const CJK = /[㐀-䶿一-鿿豈-﫿]/g;
const LATIN = /[A-Za-z]/g;
const URL_ONLY = /^\s*https?:\/\/\S+\s*$/;

/**
 * Decide which way to translate a message.
 * Mixed text like "Zace 應該載得下" counts as Chinese once Chinese characters
 * make up at least `zhRatio` of the letters (default 0.3, since one Chinese
 * character carries roughly a word's worth of meaning).
 */
export function detectLang(text: string, zhRatio = 0.3): Lang {
  if (URL_ONLY.test(text)) return "skip";
  const zh = text.match(CJK)?.length ?? 0;
  const latinWords = text.match(/[A-Za-z]+/g)?.length ?? 0;
  const latin = text.match(LATIN)?.length ?? 0;
  if (zh === 0 && latin === 0) return "skip"; // emoji, numbers, punctuation
  if (zh === 0) return latinWords >= 1 ? "en" : "skip";
  return zh / (zh + latinWords) >= zhRatio ? "zh" : "en";
}

const KANA = /[぀-ヿ]/;
const THAI = /[฀-๿]/;
// Letters only Vietnamese uses among the supported Latin-script languages.
const VIETNAMESE = /[ăâđêôơưĂÂĐÊÔƠƯạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ]/;

/**
 * Best guess at a message's language from its script alone. "latin" means
 * plain Latin letters, which could be English, Indonesian or Filipino — the
 * translation engine settles those. Chinese still needs `zhRatio` of the
 * words, so "Zace 應該載得下" is Chinese but "OK 好" is not.
 */
export function detectScript(text: string, zhRatio = 0.3): LangCode | "latin" | "skip" {
  const base = detectLang(text, zhRatio);
  if (base === "skip") return KANA.test(text) ? "ja" : THAI.test(text) ? "th" : "skip";
  if (KANA.test(text)) return "ja";
  if (THAI.test(text)) return "th";
  if (base === "zh") return "zh-TW";
  return VIETNAMESE.test(text) ? "vi" : "latin";
}
