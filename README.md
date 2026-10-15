# line-group-assistant

可重複使用的 LINE 群組助理，跑在 Cloudflare Workers 上。核心負責接收 LINE webhook、驗證簽章、分派事件；功能都做成外掛，每個群組在設定檔裡決定要開哪些。

目前內建兩個外掛：

| 外掛 | 功能 |
| --- | --- |
| `translate` | 中文訊息自動回覆英文翻譯，英文訊息回覆繁體中文翻譯。引擎可選 Google、DeepL、Claude |
| `tasks` | 任務與進度：`/任務 新增`、`開始`、`完成`、`指派`，每週一自動推播進度摘要（選用） |

`tasks` 同時是撰寫新外掛的範本，排班、工具借還、材料運送、缺料回報都可以照同樣模式寫。

## 結構

```
src/
  index.ts              Worker 進入點：/webhook 與 cron
  core/
    types.ts            Plugin 介面、群組設定、共用型別
    line.ts             LINE API 用戶端、簽章驗證
    dispatcher.ts       把事件分派給群組啟用的外掛，合併成一次回覆
  storage/
    types.ts            資料表介面（list / append / update）
    sheets.ts           Google Sheets 實作（一個分頁＝一張表）
    memory.ts           記憶體實作（測試、本機開發）
  plugins/
    index.ts            外掛註冊表
    translate/          翻譯外掛
    tasks/              任務外掛
config/groups.ts        每個群組一筆設定
test/core.test.ts       測試
```

## 設計重點

- **回覆不吃額度**：所有外掛的回覆會合併成一次 reply（最多 5 則），不算在官方帳號的每月推播額度內。只有排程摘要這類主動推播才會用到額度，而且是依群組人數計算則數。
- **背景處理**：webhook 收到後立即回 200，翻譯與寫入試算表在 `ctx.waitUntil` 裡完成，避免 LINE 逾時重送。
- **資料放在試算表**：不寫程式的成員也能直接打開 Google Sheets 查看或修正資料。分頁與欄位會自動建立。
- **未設定的群組**：機器人只會在加入時、或有人打 `/id` 時回覆群組 ID，其他訊息一律忽略。

## 部署步驟

### 1. 建立 LINE 官方帳號與 Messaging API

1. 到 [LINE Official Account Manager](https://manager.line.biz/) 建立官方帳號，方案選「輕用量」（免費）。
2. 在設定中啟用 Messaging API，並在 [LINE Developers Console](https://developers.line.biz/console/) 找到該 channel。
3. 記下 **Channel secret**，並發行一組 **Channel access token (long-lived)**。
4. 在官方帳號的「回應設定」：開啟 **Webhook**，關閉「自動回應訊息」，並開啟「**允許加入群組或多人聊天室**」。

### 2. 準備 Google 試算表（tasks 外掛需要）

1. 在 Google Cloud 建立專案，啟用 **Google Sheets API**，建立 **Service Account** 並下載 JSON 金鑰。
2. 建立一份空白試算表，用「共用」把 service account 的 email（`...@...iam.gserviceaccount.com`）加為**編輯者**。
3. 試算表網址 `https://docs.google.com/spreadsheets/d/<這段>/edit` 中間那段就是 `sheetId`。

### 3. 選擇翻譯引擎並取得金鑰

| engine | 需要的金鑰 | 說明 |
| --- | --- | --- |
| `google` | `GOOGLE_TRANSLATE_API_KEY` | Cloud Translation API，每月有免費額度 |
| `deepl` | `DEEPL_API_KEY` | DeepL API Free 金鑰結尾是 `:fx`，程式會自動用免費版網址 |
| `claude` | `ANTHROPIC_API_KEY` | 語氣最自然，可用 `glossary` 指定專有名詞譯法；預設模型 `claude-haiku-5-5` |

### 4. 部署到 Cloudflare Workers

```bash
npm install
npx wrangler login
npx wrangler secret put LINE_CHANNEL_SECRET
npx wrangler secret put LINE_CHANNEL_ACCESS_TOKEN
npx wrangler secret put GOOGLE_SERVICE_ACCOUNT_JSON   # 貼上整份 JSON
npx wrangler secret put ANTHROPIC_API_KEY             # 或 DEEPL_API_KEY / GOOGLE_TRANSLATE_API_KEY
npm run deploy
```

部署後會得到 `https://line-group-assistant.<你的帳號>.workers.dev`。到 LINE Developers Console 把 Webhook URL 設為：

```
https://line-group-assistant.<你的帳號>.workers.dev/webhook
```

### 5. 加入群組並設定

1. 把官方帳號邀請進 LINE 群組，機器人會回覆**群組 ID**（之後也可打 `/id` 查詢）。
2. 把 ID 填進 `config/groups.ts`，設定要啟用的外掛，然後再 `npm run deploy` 一次。
3. 在群組打 `/help` 確認有哪些指令可用。

## 群組設定範例

```ts
{
  groupId: "C1234…",
  name: "環樹木平台 Tree Platform",
  plugins: ["translate", "tasks"],
  storage: { type: "sheets", sheetId: "1AbC…" },
  settings: {
    translate: {
      engine: "claude",     // "google" | "deepl" | "claude"
      trigger: "all",       // "all"：每則都翻；"command"：只翻 /t 開頭的訊息
      showName: true,       // 譯文前面加上發言者名稱
      minLength: 2,         // 太短的訊息不翻
      zhRatio: 0.3,         // 中英混雜時，中文比例超過多少算中文
      glossary: "Zace = Zace; 收頭樑 = trimmer beam",
    },
    tasks: { digest: true }, // 每週一 08:00 推播進度（會用到推播額度）
  },
}
```

推播時間在 `wrangler.toml` 的 `crons` 設定，時間是 UTC（台北時間減 8 小時）。

## 指令

| 指令 | 說明 |
| --- | --- |
| `/id` | 顯示群組 ID |
| `/help` | 列出目前可用指令 |
| `/t <文字>` | 翻譯這段文字（`trigger: "command"` 時的唯一翻譯方式） |
| `/任務` 或 `/task` | 列出未完成的任務 |
| `/任務 新增 <內容> [負責:名字] [期限:10/20]` | 新增任務，未指定負責人時預設為發言者 |
| `/任務 開始 <編號>` | 標記為進行中 |
| `/任務 完成 <編號>` | 標記為完成 |
| `/任務 指派 <編號> <名字>` | 更換負責人 |

英文子指令也可以用：`/task add`、`start`、`done`、`assign`、`list`。

## 寫一個新外掛

```ts
// src/plugins/tools/index.ts
import type { Plugin } from "../../core/types";
import { text } from "../../core/types";

export const tools: Plugin = {
  name: "tools",
  commands: ["工具", "tool"],
  async onCommand(input, ctx) {
    const rows = await ctx.storage.list("tools");          // 讀「tools」分頁
    const hit = rows.find((r) => r.name === input.args[0]);
    return [text(hit ? `${hit.name} 在 ${hit.holder} 手上` : "找不到這個工具")];
  },
};
```

然後在 `src/plugins/index.ts` 註冊，並在群組設定的 `plugins` 裡加上 `"tools"`。

Plugin 介面有三個可選的 hook：

- `onMessage`：一般文字訊息（非指令）
- `onCommand`：以 `/` 開頭、且名稱在 `commands` 裡的訊息
- `onSchedule`：cron 觸發時呼叫，用 `ctx.push` 主動發訊（會用到額度）

## 開發

```bash
npm test          # vitest
npm run typecheck # tsc
npm run dev       # 本機啟動 wrangler dev
```

本機測試 webhook 時，可用 cloudflared 或 ngrok 把 `wrangler dev` 的網址暴露出去，再暫時填進 LINE 的 Webhook URL。

## 注意事項

- **隱私**：開啟 `translate` 後，群組中所有文字訊息都會送到所選的翻譯服務，請先告知群組成員。
- **額度**：輕用量方案每月 200 則推播，依「訊息數 × 收件人數」計算。10 人群組每週推一次摘要，一個月約 40 則。
- **資料一致性**：Sheets 儲存適合小型群組。多人在同一秒新增任務時，編號可能重複；人數變多時建議改用 Cloudflare D1，只要再實作一個 `Storage` 即可。
