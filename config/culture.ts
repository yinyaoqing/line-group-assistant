import type { LangCode } from "./languages";

/**
 * Festivals and customs of the cultures behind each language, for the
 * "culture" plugin: it reminds the group a couple of days ahead and shows
 * what to say. Notes are written for the Chinese-speaking side of the group.
 *
 * Lunar and Islamic dates move every year and are listed per year; extend
 * `dates` each autumn for the year after next. Islamic dates (approx: true)
 * follow the moon sighting and may shift by a day.
 */
export interface Festival {
  /** Chinese name, then the local name. */
  name: string;
  local: string;
  /** Start dates "YYYY-MM-DD", one per year, for festivals that move. */
  dates?: string[];
  /** "MM-DD" for festivals on the same date every year. */
  fixed?: string;
  /** How many days it lasts (default 1). */
  days?: number;
  /** Customs, or what not to do; one or two short lines. */
  note: string;
  /** A greeting in the language, with a reading where the script is hard to say. */
  greeting?: string;
  /** Depends on the moon sighting; may be a day off. */
  approx?: boolean;
}

/** One line of everyday etiquette per culture, shown under its festivals. */
export const TIPS: Partial<Record<LangCode, string>> = {
  id: "多數是穆斯林：不吃豬肉、不喝酒；遞東西用右手；週五中午有聚禮，可能需要半小時。",
  th: "頭是神聖的，不要摸別人的頭；腳不要指向人或佛像；對王室很尊敬，不要拿來開玩笑；打招呼雙手合十。",
  vi: "很重視長幼和稱呼；送禮避開黑色、剪刀和鐘；吃飯時長輩先動筷。",
  tl: "多數是天主教徒，週日想去望彌撒；對長輩說話會加 po／opo 表示尊重；很在意面子（hiya），有話私下講，不要當眾責備。",
  ja: "守時很重要；電車上不講電話；收到禮物通常會回禮。",
  en: "直接講重點就好；稱呼名字而不是職稱；問候時不太聊薪水和年齡。",
  "zh-TW": "送禮避開時鐘、雨傘；紅包金額用雙數；過年期間少說「死」「輸」這類字。",
};

export const FESTIVALS: Partial<Record<LangCode, Festival[]>> = {
  "zh-TW": [
    { name: "春節", local: "農曆新年", dates: ["2026-02-17", "2027-02-06"], days: 5, note: "除夕圍爐、發紅包；初一不掃地、不說不吉利的話。", greeting: "新年快樂，恭喜發財" },
    { name: "清明節", local: "掃墓", dates: ["2026-04-05", "2027-04-05"], note: "掃墓祭祖，很多人會請假回鄉。" },
    { name: "端午節", local: "龍舟節", dates: ["2026-06-19", "2027-06-09"], note: "吃粽子、划龍舟；問候說「端午安康」比「快樂」常見。", greeting: "端午安康" },
    { name: "中秋節", local: "月圓", dates: ["2026-09-25", "2027-09-15"], note: "烤肉、吃月餅和柚子，很多人會回家團圓。", greeting: "中秋節快樂" },
  ],
  vi: [
    { name: "越南新年", local: "Tết Nguyên Đán", dates: ["2026-02-17", "2027-02-06"], days: 7, note: "一年最重要的假期，很多人會提前回鄉、放一到兩週；初一第一位進門的客人（xông đất）被認為影響整年運氣，不要隨便在初一早上登門。", greeting: "Chúc mừng năm mới! An khang thịnh vượng!" },
    { name: "越南國慶", local: "Quốc khánh", fixed: "09-02", note: "國定假日，多數人休息一天。", greeting: "Chúc mừng Quốc khánh!" },
    { name: "中秋節", local: "Tết Trung thu", dates: ["2026-09-25", "2027-09-15"], note: "在越南主要是小孩的節日：送月餅、提燈籠、舞獅。", greeting: "Chúc Tết Trung thu vui vẻ!" },
  ],
  id: [
    { name: "齋戒月開始", local: "Ramadan", dates: ["2026-02-18", "2027-02-08"], days: 30, approx: true, note: "日出到日落不吃不喝。白天不要請他們吃東西、聚餐改到日落後；粗重的工作可以留意安排。", greeting: "Selamat berpuasa!" },
    { name: "開齋節", local: "Idul Fitri（Lebaran）", dates: ["2026-03-20", "2027-03-10"], days: 2, approx: true, note: "一年最大的節日，相當於過年：很多人想請假、打視訊回家，會互相請求原諒。", greeting: "Selamat Hari Raya Idul Fitri, mohon maaf lahir dan batin." },
    { name: "宰牲節", local: "Idul Adha", dates: ["2026-05-27", "2027-05-16"], approx: true, note: "祈禱後宰牛羊，把肉分給大家。", greeting: "Selamat Hari Raya Idul Adha!" },
    { name: "印尼獨立紀念日", local: "Hari Kemerdekaan", fixed: "08-17", note: "會辦升旗和趣味競賽（爬檳榔樹、吃餅乾比賽）。", greeting: "Dirgahayu Republik Indonesia!" },
  ],
  th: [
    { name: "泰國元旦", local: "วันขึ้นปีใหม่", fixed: "01-01", note: "國定假日，常和年末連成長假。", greeting: "สวัสดีปีใหม่ (sa-wat-dee pee mai)" },
    { name: "潑水節（泰國新年）", local: "สงกรานต์ Songkran", fixed: "04-13", days: 3, note: "泰國最重要的假期，很多人想回家；互相潑水祝福、向長輩澆水祈福。", greeting: "สุขสันต์วันสงกรานต์ (suk-san wan Songkran)" },
    { name: "泰王誕辰", local: "วันเฉลิมพระชนมพรรษา", fixed: "07-28", note: "國定假日；對王室要尊敬。", greeting: "ทรงพระเจริญ (song phra cha-roen)" },
    { name: "泰國母親節", local: "วันแม่แห่งชาติ", fixed: "08-12", note: "王太后生日，也是母親節，很多人會打電話回家。", greeting: "สุขสันต์วันแม่ (suk-san wan mae)" },
  ],
  tl: [
    { name: "聖週（耶穌受難日）", local: "Semana Santa / Biyernes Santo", dates: ["2026-04-03", "2027-03-26"], days: 3, note: "天主教徒最重要的宗教日子，很多人守齋、想休息，不適合排慶祝活動。" },
    { name: "菲律賓獨立紀念日", local: "Araw ng Kalayaan", fixed: "06-12", note: "國定假日。", greeting: "Maligayang Araw ng Kalayaan!" },
    { name: "諸聖節", local: "Undas", fixed: "11-01", days: 2, note: "全家到墓園掃墓、守夜，類似清明。" },
    { name: "聖誕節", local: "Pasko", fixed: "12-25", note: "全世界最長的聖誕季，從 9 月就開始。12/24 平安夜全家吃 Noche Buena，很多人想打視訊回家。", greeting: "Maligayang Pasko!" },
  ],
  ja: [
    { name: "日本新年", local: "お正月", fixed: "01-01", days: 3, note: "一年最重要的假期，12/29 到 1/3 多數公司放假。", greeting: "明けましておめでとうございます" },
    { name: "黃金週", local: "ゴールデンウィーク", fixed: "04-29", days: 7, note: "連假，很多人返鄉或旅遊。" },
    { name: "盂蘭盆節", local: "お盆", fixed: "08-13", days: 4, note: "祭祖返鄉，像台灣的清明加中元。" },
  ],
  en: [
    { name: "新年", local: "New Year's Day", fixed: "01-01", note: "前一晚跨年，元旦多數人休息。", greeting: "Happy New Year!" },
    { name: "感恩節（美國）", local: "Thanksgiving", dates: ["2026-11-26", "2027-11-25"], note: "家庭聚餐，週四到週日很難聯絡到人。", greeting: "Happy Thanksgiving!" },
    { name: "聖誕節", local: "Christmas", fixed: "12-25", note: "多數英語國家最大的家庭節日，12/24 到 12/26 很難聯絡到人。", greeting: "Merry Christmas!" },
  ],
};
