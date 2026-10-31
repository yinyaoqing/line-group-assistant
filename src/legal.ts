import { PLANS, TOP_UP } from "../config/plans";
import { addFriendUrl, SITE } from "../config/site";

/**
 * Privacy policy (/privacy) and terms of service (/terms). Written from what
 * the code actually does; when behaviour changes (what is stored, which
 * services see messages, how long data is kept), change the text here too.
 */
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const fmt = (n: number) => n.toLocaleString("en-US");

/** The date the text was last changed; shown on both pages. */
export const LEGAL_UPDATED = "2026-10-31";

function page(title: string, body: string): string {
  const name = esc(SITE.name);
  return `<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}｜${name}</title>
<meta name="robots" content="noindex">
<style>
  :root { --bg: #f7f8f6; --ink: #14171a; --muted: #5d6670; --line: #e3e6e2; --green: #06c755; color-scheme: light; }
  @media (prefers-color-scheme: dark) { :root { --bg: #0f1211; --ink: #eef1ef; --muted: #9aa49f; --line: #2a302d; color-scheme: dark; } }
  body { margin: 0; background: var(--bg); color: var(--ink); font: 16px/1.75 -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans TC", "PingFang TC", "Microsoft JhengHei", sans-serif; }
  .wrap { max-width: 760px; margin: 0 auto; padding: 32px 20px 64px; }
  a { color: inherit; }
  .brand { display: inline-flex; align-items: center; gap: 10px; font-weight: 800; text-decoration: none; font-size: 18px; margin-bottom: 28px; }
  .brand i { width: 30px; height: 30px; border-radius: 9px; background: var(--green); display: grid; place-items: center; color: #fff; font-style: normal; font-size: 16px; }
  h1 { font-size: 30px; margin: 0 0 4px; letter-spacing: -0.3px; }
  .meta { color: var(--muted); margin: 0 0 28px; font-size: 14px; }
  h2 { font-size: 20px; margin: 32px 0 8px; }
  p, li { color: var(--ink); }
  ul { padding-left: 22px; }
  li { margin: 4px 0; }
  table { border-collapse: collapse; width: 100%; font-size: 15px; margin: 8px 0; }
  th, td { text-align: left; vertical-align: top; padding: 8px 10px; border-top: 1px solid var(--line); }
  th { color: var(--muted); font-weight: 600; white-space: nowrap; }
  .en { color: var(--muted); font-size: 15px; border-left: 3px solid var(--line); padding-left: 14px; margin: 0 0 28px; }
  footer { margin-top: 48px; padding-top: 20px; border-top: 1px solid var(--line); color: var(--muted); font-size: 14px; display: flex; gap: 16px; flex-wrap: wrap; }
</style>
</head>
<body>
<div class="wrap">
  <a class="brand" href="/"><i>${esc(SITE.mark)}</i>${name}</a>
  ${body}
  <footer><a href="/">首頁</a><a href="/privacy">隱私權政策</a><a href="/terms">服務條款</a><span>最後更新 ${LEGAL_UPDATED}</span></footer>
</div>
</body>
</html>`;
}

/** How to reach us: the LINE official account, plus email when one is set. */
function contact(): string {
  const line = `LINE 官方帳號 <a href="${addFriendUrl(SITE.lineId)}">${esc(SITE.lineId)}</a>`;
  return SITE.contactEmail ? `${line}，或寄信到 <a href="mailto:${esc(SITE.contactEmail)}">${esc(SITE.contactEmail)}</a>` : line;
}

export function privacyHtml(): string {
  const name = esc(SITE.name);
  return page(
    "隱私權政策",
    `
  <h1>隱私權政策</h1>
  <p class="meta">適用於 ${name}（${esc(SITE.tagline)}）LINE 官方帳號與設定頁。</p>
  <p class="en">English summary: ${name} is a LINE group bot. To translate, it sends each text message in the group to the translation service the group chose (Google Cloud Translation, DeepL or Anthropic Claude) and does not keep the original text. It stores what members deliberately create (tasks, reports, tool and material counts), each member's language preference, group settings, admins' LINE IDs and monthly usage counts, on Cloudflare. Data is kept while the group uses the service; ask us to delete it at any time.</p>

  <h2>1. 我們是誰</h2>
  <p>${name}由個人開發者在台灣營運。聯絡方式：${contact()}。</p>

  <h2>2. 群組訊息怎麼被處理</h2>
  <ul>
    <li>群組開啟自動翻譯後，群組裡<strong>每一則文字訊息</strong>都會送到該群組選用的翻譯服務，翻完後把譯文回到群組。翻譯服務可能是 Google Cloud Translation、DeepL 或 Anthropic Claude，由群組管理員在設定頁選擇。</li>
    <li>我們<strong>不保存</strong>這些訊息的原文或譯文。訊息只在處理期間經過我們在 Cloudflare 的程式，處理完即丟棄。</li>
    <li>如果成員用「@${name}」對 AI 助理下指令，那句話連同群組目前的任務和物品清單會送到 Anthropic Claude 以理解意圖。</li>
    <li>貼圖、照片、檔案、語音不會被處理，也不會送到任何服務。</li>
    <li>翻譯服務依其各自的條款處理這些文字。據我們所知，上述服務的 API 都不會用客戶送出的內容訓練模型；詳情請見各服務的隱私條款。</li>
  </ul>
  <p>請管理員在開啟自動翻譯前告知群組成員。</p>

  <h2>3. 我們保存哪些資料</h2>
  <table>
    <tr><th>資料</th><td>內容</td><td>為什麼</td></tr>
    <tr><th>群組</th><td>LINE 群組 ID、群組名稱、開啟的功能、設定（語言、詞彙表、語氣說明等）、方案與到期日</td><td>讓機器人知道在這個群組要做什麼</td></tr>
    <tr><th>管理員</th><td>管理員的 LINE 用戶 ID；開過設定頁的話還有 LINE Login 的用戶 ID</td><td>只有管理員能改設定</td></tr>
    <tr><th>成員語言</th><td>每位成員的 LINE 用戶 ID、使用的語言、最後發言時間</td><td>只翻成成員實際使用的語言，減少洗版</td></tr>
    <tr><th>任務</th><td>任務內容、負責人名字、期限、狀態、完成回報、建立者名字、時間；這些文字的翻譯</td><td>成員用 /add、/todo 主動建立的工作紀錄</td></tr>
    <tr><th>工具、材料</th><td>名稱、數量、異動者名字與時間</td><td>成員用 /tool、/material 主動建立</td></tr>
    <tr><th>用量</th><td>每月翻譯字元數、AI 助理使用次數</td><td>計算方案額度</td></tr>
    <tr><th>排程訊息</th><td>等待送出的每週摘要、節日提醒（由機器人產生，不含成員訊息）</td><td>搭下一次回覆送出，不用推播額度</td></tr>
    <tr><th>啟用紀錄</th><td>啟用碼由哪個群組、哪位成員、何時使用</td><td>防止重複使用</td></tr>
  </table>
  <p>成員的顯示名稱不存在我們的資料庫，需要時向 LINE 即時取得；任務和物品紀錄裡的名字是成員自己輸入或建立當下記下的。</p>

  <h2>4. 資料放在哪裡</h2>
  <p>服務跑在 Cloudflare Workers，資料存在 Cloudflare D1 資料庫，Cloudflare 會依其網路配置決定實際存放的資料中心。如果群組管理員選擇改用 Google 試算表儲存，任務與物品資料會改放在該群組自己提供的 Google 試算表裡。</p>

  <h2>5. 誰看得到</h2>
  <ul>
    <li>群組管理員：透過設定頁看到自己群組的設定、用量、任務與物品報表。</li>
    <li>平台管理員（營運者）：為了開通方案、處理問題，可以看到所有群組的設定與用量，以及任務與物品資料。我們不會讀取群組的對話，技術上也沒有保存。</li>
    <li>翻譯與 AI 服務供應商：只收到送去翻譯或理解的那段文字。</li>
    <li>我們不出售資料，也不提供給上述以外的第三方，除非法律要求。</li>
  </ul>

  <h2>6. 保存多久、怎麼刪除</h2>
  <ul>
    <li>群組使用期間資料持續保存。</li>
    <li>機器人被移出群組後，目前<strong>不會自動刪除</strong>該群組的資料；請用第 1 節的方式聯絡我們，我們會在收到後 30 天內刪除。</li>
    <li>成員可以要求刪除自己的語言偏好與名字出現的紀錄；群組管理員可以要求刪除整個群組的資料。</li>
    <li>設定頁的登入狀態保存在你的手機瀏覽器裡，12 小時後失效。</li>
  </ul>

  <h2>7. 安全</h2>
  <p>LINE 送來的每個事件都會驗證簽章；設定頁連結只能用一次、10 分鐘內有效，並且只有在群組輸入 /settings 的那位管理員能用；白牌客戶的金鑰加密後存放。網路上沒有絕對安全的服務，若發生資料外洩，我們會通知受影響的群組管理員。</p>

  <h2>8. 修改</h2>
  <p>政策內容更新時會改動頁首的日期；重大變更會在群組裡通知管理員。繼續使用代表同意更新後的內容。</p>
`,
  );
}

export function termsHtml(): string {
  const name = esc(SITE.name);
  const starter = PLANS.starter;
  const advanced = PLANS.advanced;
  return page(
    "服務條款",
    `
  <h1>服務條款</h1>
  <p class="meta">使用 ${name}（${esc(SITE.tagline)}）即表示同意以下條款。</p>
  <p class="en">English summary: ${name} is provided as is. Machine translation can be wrong; always confirm safety-critical instructions in person. Paid plans are billed per group or per user by bank transfer and fall back to the free plan when they expire. We may suspend groups that abuse the service. These terms are governed by the laws of Taiwan.</p>

  <h2>1. 服務內容</h2>
  <p>${name}是加進 LINE 群組使用的機器人，提供訊息自動翻譯、任務與進度、工具材料數量、報表匯出、節日提醒等功能，以及在 LINE 裡開啟的設定頁。功能可能新增、調整或停止，重大變更會在群組裡通知管理員。</p>

  <h2>2. 翻譯只是輔助</h2>
  <p>翻譯由機器產生，可能有錯、漏譯或語氣不對。<strong>涉及安全、健康、金錢、法律或契約的內容，請務必由懂雙方語言的人當面確認</strong>，不要只依賴譯文。我們對因依賴譯文造成的損失不負責任。</p>

  <h2>3. 帳號與管理員</h2>
  <ul>
    <li>在群組輸入 /activate 啟用的成員成為該群組的管理員，可以新增其他管理員。管理員要對群組的設定與啟用碼的保管負責。</li>
    <li>啟用碼只能用一次，請勿轉讓或公開。</li>
    <li>請在開啟自動翻譯前告知群組成員，取得他們的同意。</li>
  </ul>

  <h2>4. 方案與付款</h2>
  <ul>
    <li>免費版有每月翻譯字元上限（所有群組合計）與語言限制；用完後自動翻譯暫停，下個月 1 日（台北時間）恢復。</li>
    <li>方案以人計價，不限群組數，所有群組合計用量：入門版每人每月 NT$${fmt(starter.price)}、進階版每人每月 NT$${fmt(advanced.price)}，進階版可加購 ${fmt(TOP_UP.chars)} 字 NT$${fmt(TOP_UP.price)}。實際金額以網站公告為準。</li>
    <li>翻譯字數以原文字數乘以翻譯的語言數計算，每則每種語言至少以 10 字計；選用 Claude Opus 時以 15 倍計。</li>
    <li>群組的用量算在啟用它的成員的帳號；群組管理員中若有其他付費成員，可以改由他的帳號支付。</li>
    <li>付款方式為轉帳；我們收到款項後為你的帳號開通，並設定到期日。到期未續約自動回到免費版，已建立的任務與物品資料保留。</li>
    <li>價格調整至少提前 30 天公告，已付期間不受影響。</li>
    <li>退費依個案處理，請聯絡我們。</li>
  </ul>

  <h2>5. 不可以做的事</h2>
  <ul>
    <li>用本服務傳送違法、騷擾、詐騙或侵害他人權利的內容。</li>
    <li>大量自動發送訊息、規避額度，或試圖存取其他群組的資料。</li>
    <li>違反 LINE 的使用條款。</li>
  </ul>
  <p>違反時我們可以暫停或終止該群組的服務，不另退費。</p>

  <h2>6. 可用性與責任限制</h2>
  <p>本服務依現況提供，不保證不中斷或無錯誤。服務依賴 LINE、Cloudflare 與翻譯服務供應商，這些服務異常時本服務也會受影響。在法律允許的範圍內，我們對任何間接或衍生損失不負責任；直接損失的賠償以該群組過去三個月支付給我們的費用為上限。</p>

  <h2>7. 資料</h2>
  <p>資料的處理方式請見<a href="/privacy">隱私權政策</a>。群組建立的任務與物品資料屬於群組，可隨時用 /report 匯出。</p>

  <h2>8. 終止</h2>
  <p>把機器人移出群組即停止使用。付費期間內移出，剩餘期間不退費，重新邀請後可繼續使用到原到期日。</p>

  <h2>9. 準據法</h2>
  <p>本條款以中華民國（台灣）法律為準據法，如有爭議以台灣宜蘭地方法院為第一審管轄法院。</p>

  <h2>10. 聯絡</h2>
  <p>${contact()}</p>
`,
  );
}
