# line-group-assistant

可重複使用的 LINE 群組助理，跑在 Cloudflare Workers 上。核心負責接收 LINE webhook、驗證簽章、分派事件；功能都做成外掛，每個群組在 LINE 裡的設定頁決定要開哪些。支援方案與額度，以及一個 Worker 服務多個客戶自己的 LINE 官方帳號（白牌）。

目前內建兩個外掛：

| 外掛 | 功能 |
| --- | --- |
| `translate` | 每則訊息自動翻成群組選的其他語言（中文、英文、越南文、印尼文、泰文、菲律賓文、日文）。引擎可選 Google、DeepL、Claude |
| `tasks` | 任務與進度：`/add`、`/todo`、開始／完成按鈕，每週一自動推播進度摘要（選用） |
| `tools` | 工具數量表：`/tool 線鋸 1` 新增或累加、卡片上按 ±1、`/tool set` 改數量 |
| `materials` | 材料數量表：`/material 螺絲 100`，用法同工具（也可打 `/mat`） |

`tasks` 同時是撰寫新外掛的範本，排班、工具借還、材料運送、缺料回報都可以照同樣模式寫。

## 結構

```
src/
  index.ts              Worker 進入點：/webhook、/webhook/<頻道>、/app、/api、cron
  api.ts                設定頁與平台管理的 JSON API
  app/index.html        設定頁（LIFF，在 LINE 裡開啟）
  core/
    types.ts            Plugin 介面、群組設定、共用型別
    line.ts             LINE API 用戶端、簽章驗證
    dispatcher.ts       分派事件、/activate、/settings、/admin
    crypto.ts           簽章連結與 session、白牌金鑰加密
  storage/
    types.ts            資料表介面（list / append / update）
    d1.ts               Cloudflare D1 實作（預設）
    sheets.ts           Google Sheets 實作（一個分頁＝一張表，選用）
    memory.ts           記憶體實作（測試、本機開發）
    groups.ts           群組設定與用量計量（D1）
    admins.ts           群組管理員、一次性連結
    channels.ts         白牌頻道
  plugins/
    index.ts            外掛註冊表
    translate/          翻譯外掛（terms.ts：任務與工具名稱的翻譯）
    tasks/              任務外掛
    counter/            數量表外掛範本，產生 tools（/tool）與 materials（/material）
config/defaults.ts      新群組的預設外掛與設定
config/plans.ts         方案、價格與額度
config/languages.ts     支援的翻譯語言
migrations/             D1 資料表結構
test/                   測試（d1.test.ts 會在本機模擬的 D1 上跑真的 SQL）
```

## 設計重點

- **回覆不吃額度**：所有外掛的回覆會合併成一次 reply（最多 5 則），不算在官方帳號的每月推播額度內。只有排程摘要這類主動推播才會用到額度，而且是依群組人數計算則數。
- **背景處理**：webhook 收到後立即回 200，翻譯與寫入試算表在 `ctx.waitUntil` 裡完成，避免 LINE 逾時重送。
- **設定與資料放在 D1**：群組設定、任務、用量都在 Cloudflare D1，新增群組不用改程式、不用重新部署。個別群組也可以改用 Google Sheets 儲存，讓不寫程式的成員直接查看或修正資料。
- **邀請即登記、啟用碼開通**：機器人被邀進群組時自動登記為「待啟用」，只回覆群組 ID；有人輸入 `/activate <啟用碼>` 後才開始翻譯、記任務，避免陌生群組用掉翻譯額度。啟用碼是**一次性**的：平台管理員在設定頁「啟用碼」分頁逐組產生，每組只能用一次、可設有效天數，也可以帶方案（例如專業版到 12/31），群組一啟用就套用。
- **用量計量**：每個群組每月翻譯的字元數記在 `usage` 表（翻成 N 種語言就算 N 次），超過方案額度就暫停自動翻譯並提示一次，下個月（台北時間）自動恢復。
- **方案**：在 [config/plans.ts](config/plans.ts) 定義。免費版 5 萬字／月、中英互譯；專業版 NT$249／群組／月、50 萬字、全部語言、每週摘要。目前沒有串金流：客戶付款後，平台管理員在設定頁的「所有群組」把方案改成 pro 並填到期日，過期自動回到免費版。
- **管理員**：輸入 `/activate` 的人成為群組擁有者，可用 `/admin add @成員` 新增管理員。只有管理員能用 `/settings` 取得設定頁連結（10 分鐘內有效、只能用一次）。
- **白牌**：客戶自己的官方帳號登記在 `channels` 表，webhook 是 `/webhook/<代號>`，金鑰用 `APP_SECRET` 加密後存放。

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
npx wrangler d1 create line-group-assistant           # 把輸出的 database_id 填進 wrangler.toml
npm run db:migrate                                     # 建立 D1 資料表
npx wrangler secret put LINE_CHANNEL_SECRET
npx wrangler secret put LINE_CHANNEL_ACCESS_TOKEN
npx wrangler secret put GOOGLE_TRANSLATE_API_KEY      # 或 DEEPL_API_KEY / ANTHROPIC_API_KEY
npx wrangler secret put APP_SECRET                    # 隨機長字串：簽設定頁連結、加密白牌金鑰（換掉會讓白牌金鑰失效）
npx wrangler secret put GOOGLE_SERVICE_ACCOUNT_JSON   # 選用：有群組要用試算表儲存時才需要
npm run deploy
```

部署後會得到 `https://line-group-assistant.<你的帳號>.workers.dev`。到 LINE Developers Console 把 Webhook URL 設為：

```
https://line-group-assistant.<你的帳號>.workers.dev/webhook
```

### 5. 開通設定頁（LIFF）

1. 在 [LINE Developers Console](https://developers.line.biz/console/) 同一個 Provider 下新增一個 **LINE Login** channel（類型選 Web app）。
2. 在該 channel 的 **LIFF** 分頁按 Add：
   - Size：**Full**
   - Endpoint URL：`https://line-group-assistant.<你的帳號>.workers.dev/app`
   - Scope：勾選 **openid**、**profile**
3. 把 **LIFF ID**（像 `2001234567-AbCdEfGh`）和 LINE Login 的 **Channel ID** 填進 `wrangler.toml` 的 `[vars]`，再 `npm run deploy`。
4. 把 LINE Login channel 從 Developing 切成 **Published**，否則只有開發者帳號能登入。
5. 在群組輸入 `/settings` 開設定頁，頁首會顯示你的「帳號 ID」。把它設成平台管理員後重新整理，就會看到「所有群組」「白牌頻道」：
   ```bash
   npx wrangler secret put PLATFORM_ADMINS   # 多人用逗號分隔
   ```

### 6. 加入群組並設定

1. 把官方帳號邀請進 LINE 群組，機器人會自動登記這個群組並回覆群組 ID。
2. 平台管理員在設定頁「啟用碼」分頁產生一組啟用碼，在群組輸入 `/activate <啟用碼>`，輸入的人成為這個群組的管理員。第一次部署時還沒有平台管理員，可以先用下面的 SQL 產生一組：
   ```bash
   npx wrangler d1 execute line-group-assistant --remote --command "INSERT INTO activation_codes (code, label) VALUES ('FIRSTCODE2345', 'first')"
   ```
   然後在群組輸入 `/activate FIRS-TCOD-E234-5`（大小寫、`-` 都不影響）。
3. 輸入 `/settings` 開設定頁，選語言、功能；輸入 `/help` 查看指令。

### 7. 新增白牌客戶

1. 客戶建立自己的官方帳號與 Messaging API channel，把 Channel secret 與 access token 給你。
2. 平台管理員在設定頁「白牌頻道」新增，取一個代號（例如 `acme`），選擇群組要「邀請即啟用」或「需要啟用碼」；需要啟用碼時，在「啟用碼」分頁選這個頻道產生，啟用碼只能用在該頻道。
3. 把頁面顯示的 `https://…/webhook/acme` 填進客戶 channel 的 Webhook URL，並照第 1 步開啟群組、關閉自動回應。

## 群組設定

大部分設定在 LINE 裡的設定頁就能改（`/settings`）：功能開關、翻譯語言、翻譯哪些訊息、顯示名字、詞彙表、每週摘要。引擎、額度覆寫、方案、到期日只有平台管理員能在「所有群組」修改。

新群組的預設值在 [config/defaults.ts](config/defaults.ts)。設定存在 D1 的 `groups` 表，`plugins`、`settings`、`storage` 三欄是 JSON，也可以用 SQL 修改：

```bash
# 查看所有群組
npx wrangler d1 execute line-group-assistant --remote --command "SELECT group_id, name, status FROM groups"
# 調整某群組的翻譯額度（每月字元數，0 = 不限）
npx wrangler d1 execute line-group-assistant --remote --command \
  "UPDATE groups SET settings = json_set(settings, '$.translate.monthlyChars', 300000) WHERE group_id = 'C1234…'"
# 查看本月用量
npx wrangler d1 execute line-group-assistant --remote --command "SELECT * FROM usage ORDER BY month DESC"
```

`settings` 範例：

```json
{
  "translate": {
    "engine": "google",
    "languages": ["zh-TW", "en", "vi"],
    "trigger": "all",
    "showName": true,
    "minLength": 2,
    "zhRatio": 0.3,
    "monthlyChars": 100000,
    "glossary": "Zace = Zace; 收頭樑 = trimmer beam"
  },
  "tasks": { "digest": true }
}
```

- `engine`：`"google"`、`"deepl"` 或 `"claude"`。DeepL 不支援越南文、泰文、菲律賓文。
- `languages`：要互譯的語言，見 [config/languages.ts](config/languages.ts)。每則訊息會翻成其他所有語言；方案沒有包含的語言會被略過。
- `trigger`：`"all"` 每則都翻；`"command"` 只翻 `/t` 開頭的訊息。
- `showName`：譯文前面加上發言者名稱。`minLength`：太短的訊息不翻。`zhRatio`：中英混雜時，中文比例超過多少算中文。
- `monthlyChars`：覆寫方案的每月翻譯字元上限，`0` 為不限；不填就用方案額度。`glossary`：專有名詞譯法（僅 `claude` 引擎使用）。
- `tasks.digest`：每週一 08:00 推播進度（會用到推播額度）。

`storage` 預設為 `{"type":"d1"}`；要讓群組資料存在試算表，改成 `{"type":"sheets","sheetId":"1AbC…"}`，並把試算表共用給 service account。

推播時間在 `wrangler.toml` 的 `crons` 設定，時間是 UTC（台北時間減 8 小時）。

## 指令

| 指令 | 說明 |
| --- | --- |
| `/id` | 顯示群組 ID 與是否已啟用 |
| `/activate <啟用碼>` | 用一次性啟用碼開通這個群組，輸入的人成為擁有者；啟用碼用過即失效 |
| `/settings` | 管理員取得設定頁連結 |
| `/admin`、`/admin add @成員`、`/admin remove @成員` | 查看、新增、移除管理員（移除限擁有者） |
| `/help` | 使用說明：依功能分組，每個指令附範例 |
| `/menu` | 功能選單卡片：每個功能一個大按鈕。**電腦版 LINE 不會顯示輸入框上方的快速按鈕**（那是 LINE 手機版才有的功能），電腦版請用這張卡片 |
| `/template`、`/template tool` | 指令範本卡片：按「📋 複製」→ 貼到輸入框 → 改內容送出；加功能名稱只看該功能的範本。舊版 LINE 不支援複製按鈕時，改送一則一則可長按複製的訊息 |
| `/t <文字>` | 翻譯這段文字（`trigger: "command"` 時的唯一翻譯方式） |
| `/translate off`、`/translate on` | 關閉／開啟本群組的自動翻譯，關閉時 `/t` 仍可用；狀態存在試算表的 `translate` 分頁 |
| `/translate` | 顯示自動翻譯目前是開啟或關閉，附一鍵切換按鈕 |
| `/todo`（或 `/task`） | 未完成任務卡片，每筆都有「開始」「完成」按鈕 |
| `/add <內容> [@名字] [10/20]`（或 `/task add …`） | 新增任務，例：`/add 買早餐 @JOJO 10/17`。`@名字`（或 `owner:名字`）指定負責人，未指定時預設為發言者；結尾的日期（`10/17`、`10-17`、`2026/10/17`，或 `due:10/17`）當作期限 |
| `/task start <編號>` | 標記為進行中（通常直接點按鈕） |
| `/task done <編號> <現況>` | 完成並回報現況，例：`/task done 3 租到 2 台線鋸，週五下午可取`。點卡片的「完成」按鈕時沒有現況，機器人會請按的人在 10 分鐘內直接回覆一則訊息當作回報；沒回報前任務不會完成 |
| `/task fail <編號> [原因]` | 標記為失敗，可附原因，例：`/task fail 3 下雨延期`。失敗和完成一樣不再出現在 `/todo`；`/task start <編號>` 可重新開始 |
| `/task assign <編號> <名字>` | 更換負責人 |
| `/tool`、`/material` | 工具／材料卡片：每項顯示數量，附「−1」「+1」按鈕 |
| `/tool <名稱> [數量]`、`/material <名稱> [數量]` | 新增或累加，例：`/tool 線鋸 1`、`/material 螺絲 100`；負數減少，不填數量就是 +1。同名（不分大小寫，或與譯名相同）會疊加 |
| `/tool set`、`/tool del`（材料同） | 直接設定數量、從清單移除 |
| `/report` | 任務、工具、材料的摘要，附 24 小時有效的報表連結：統計、明細、下載 CSV（Excel 可開）、列印成 PDF |

指令一律使用英文；任務內容、名字可以用中文。

**手機操作**：機器人回覆指令時，輸入框上方會出現快速按鈕（任務、翻譯開關、說明），新增任務後也會出現「開始 #N／完成 #N」。點按鈕等於替你送出對應指令，群組成員看得到是誰按的。中文鍵盤打出的全形「／」、被自動大寫的 `/Todo` 都能辨識。

## 寫一個新外掛

```ts
// src/plugins/roster/index.ts
import type { Plugin } from "../../core/types";
import { text } from "../../core/types";

export const roster: Plugin = {
  name: "roster",
  commands: ["shift"],
  help: { title: "🗓 排班 Roster", lines: ["/shift 10/20　看那天誰上班"] },
  async onCommand(input, ctx) {
    const rows = await ctx.storage.list("roster");         // 讀「roster」表
    const today = rows.filter((r) => r.date === input.args[0]);
    return [text(today.length ? today.map((r) => `${r.date} ${r.name}`).join("\n") : "那天沒有排班")];
  },
};
```

然後在 `src/plugins/index.ts` 註冊，並在群組的 `plugins` 加上 `"roster"`（設定頁的功能開關也要加一列）。

只是要另一種「數量表」（例如「設備」），不用寫新外掛：在 [src/plugins/counter/index.ts](src/plugins/counter/index.ts) 用 `counterPlugin({...})` 再產生一個即可。

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

本機試設定頁不用 LINE 登入：在 `.dev.vars`（已被 git 忽略）寫入

```
DEV_MODE=1
APP_SECRET=local-dev-secret
PLATFORM_ADMINS=boss
```

執行 `npm run db:migrate:local` 與 `npm run dev`，開 `http://localhost:8787/app?dev=boss`（加 `&group=<群組ID>` 直接進某個群組，`#admin`、`#channels` 進平台管理）。`DEV_MODE` 絕對不要設在正式環境。

## 注意事項

- **隱私**：開啟 `translate` 後，群組中所有文字訊息都會送到所選的翻譯服務，請先告知群組成員。
- **額度**：輕用量方案每月 200 則推播，依「訊息數 × 收件人數」計算。10 人群組每週推一次摘要，一個月約 40 則。
- **資料一致性**：D1 儲存的任務編號以單一 SQL 原子遞增，多人同時新增也不會重複。Sheets 儲存適合小型群組：多人在同一秒新增任務時編號可能重複，而且 Sheets API 每分鐘的請求數是整個 Google Cloud 專案共用，群組多時請用 D1。
- **啟用碼**：每組只能用一次，在群組裡被看到也無法再用；還沒用的可以在「啟用碼」分頁作廢。
