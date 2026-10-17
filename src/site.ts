import { LANGUAGES } from "../config/languages";
import { PLANS } from "../config/plans";
import { addFriendUrl, SITE } from "../config/site";

/**
 * The public one-page product site, served at "/". Plans and languages come
 * from config/plans.ts and config/languages.ts, so the page follows any change
 * to prices or quotas; brand and contact live in config/site.ts.
 */
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const fmt = (n: number) => n.toLocaleString("en-US");

/** "50,000" characters as rough messages, assuming ~25 characters a message. */
const asMessages = (chars: number) => `約 ${fmt(Math.round(chars / 25 / 100) * 100)} 則訊息`;

export function siteHtml(origin: string): string {
  const free = PLANS.free;
  const pro = PLANS.pro;
  const join = addFriendUrl(SITE.lineId);
  const name = esc(SITE.name);
  const langList = (codes: string[]) => codes.map((c) => LANGUAGES[c as keyof typeof LANGUAGES]).map((l) => `${l.flag} ${esc(l.name)}`).join("　");
  const check = (text: string, on = true) => `<li class="${on ? "" : "off"}">${on ? "✓" : "—"} ${text}</li>`;

  return `<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${name}｜${esc(SITE.tagline)}：多語翻譯、任務、工具材料一次搞定</title>
<meta name="description" content="把 ${name} 拉進 LINE 群組：訊息自動翻成中、英、越、印、泰、菲、日文，任務指派與完成回報、工具材料數量、一鍵匯出報表。免費開始。">
<meta property="og:title" content="${name}｜${esc(SITE.tagline)}">
<meta property="og:description" content="LINE 群組自動多語翻譯、任務追蹤、工具材料數量、報表匯出。">
<meta property="og:type" content="website">
<meta property="og:url" content="${esc(origin)}/">
<style>
  :root {
    --bg: #f7f8f6; --surface: #ffffff; --ink: #14171a; --muted: #5d6670; --line: #e3e6e2;
    --green: #06c755; --green-ink: #04502a; --green-soft: #e6f8ee; --accent: #ff8a00;
    --bubble: #ffffff; --bubble-me: #8de06e; --chat: #8cabd9;
    color-scheme: light;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0f1211; --surface: #181c1b; --ink: #eef1ef; --muted: #9aa49f; --line: #2a302d;
      --green-ink: #8ff0b6; --green-soft: #12301f; --bubble: #2a2f2d; --bubble-me: #2f6b3a; --chat: #20304a;
      color-scheme: dark;
    }
  }
  * { box-sizing: border-box; }
  html { scroll-behavior: smooth; }
  body { margin: 0; background: var(--bg); color: var(--ink); font: 16px/1.65 -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans TC", "PingFang TC", "Microsoft JhengHei", sans-serif; }
  a { color: inherit; }
  .wrap { max-width: 1080px; margin: 0 auto; padding-inline: 20px; }
  header { position: sticky; top: env(safe-area-inset-top, 0px); z-index: 5; background: color-mix(in srgb, var(--bg) 88%, transparent); backdrop-filter: blur(8px); border-bottom: 1px solid var(--line); }
  header .wrap { display: flex; align-items: center; justify-content: space-between; gap: 12px; height: 60px; }
  .brand { display: flex; align-items: center; gap: 10px; font-weight: 800; text-decoration: none; font-size: 18px; }
  .brand i { width: 30px; height: 30px; border-radius: 9px; background: var(--green); display: grid; place-items: center; color: #fff; font-style: normal; font-size: 16px; }
  .brand small { font-weight: 500; color: var(--muted); font-size: 13px; }
  nav { display: flex; gap: 20px; font-size: 15px; }
  nav a { text-decoration: none; color: var(--muted); }
  nav a:hover { color: var(--ink); }
  @media (max-width: 720px) { nav { display: none; } }
  .btn { display: inline-flex; align-items: center; gap: 8px; padding: 12px 20px; border-radius: 999px; background: var(--green); color: #fff; font-weight: 700; text-decoration: none; white-space: nowrap; }
  .btn.small { padding: 8px 16px; font-size: 14px; }
  .btn.ghost { background: transparent; color: var(--ink); border: 1.5px solid var(--line); font-weight: 600; }

  .hero { padding-block: 64px 48px; display: grid; grid-template-columns: 1.1fr 0.9fr; gap: 48px; align-items: center; }
  @media (max-width: 860px) { .hero { grid-template-columns: 1fr; padding-block: 40px 32px; } }
  .eyebrow { display: inline-block; font-size: 13px; font-weight: 700; color: var(--green-ink); background: var(--green-soft); padding: 4px 12px; border-radius: 999px; margin-bottom: 16px; }
  h1 { font-size: clamp(32px, 5.2vw, 52px); line-height: 1.18; margin: 0 0 18px; letter-spacing: -0.5px; }
  h1 em { font-style: normal; color: var(--green); }
  .lead { font-size: 18px; color: var(--muted); margin: 0 0 28px; max-width: 34em; }
  .cta { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; }
  .langs { margin-top: 22px; font-size: 14px; color: var(--muted); }

  .phone { background: var(--chat); border-radius: 28px; padding: 18px 14px; border: 8px solid #1c2024; box-shadow: 0 24px 60px rgba(0,0,0,.18); max-width: 380px; width: 100%; justify-self: center; font-size: 14px; line-height: 1.5; }
  .phone .top { text-align: center; font-weight: 700; color: #fff; margin: -4px 0 12px; font-size: 14px; text-shadow: 0 1px 2px rgba(0,0,0,.25); }
  .msg { display: flex; gap: 8px; margin: 10px 0; align-items: flex-end; }
  .msg .av { width: 30px; height: 30px; border-radius: 50%; flex: none; display: grid; place-items: center; font-size: 13px; color: #fff; font-weight: 700; }
  .msg .who { font-size: 11px; color: #fff; opacity: .9; margin: 0 0 2px 2px; }
  .b { background: var(--bubble); color: var(--ink); padding: 8px 12px; border-radius: 16px; border-top-left-radius: 4px; max-width: 260px; }
  .msg.me { justify-content: flex-end; }
  .msg.me .b { background: var(--bubble-me); border-top-left-radius: 16px; border-top-right-radius: 4px; color: #0b2410; }
  @media (prefers-color-scheme: dark) { .msg.me .b { color: #eafbe9; } }
  .b.bot { border: 1.5px solid var(--green); }
  .b small { display: block; color: var(--muted); font-size: 12px; }
  .chips { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 12px; }
  .chips span { background: var(--bubble); border: 1px solid var(--line); border-radius: 999px; padding: 4px 10px; font-size: 12px; }

  section { padding-block: 64px; }
  section.alt { background: var(--surface); border-block: 1px solid var(--line); }
  h2 { font-size: clamp(26px, 3.6vw, 36px); margin: 0 0 10px; letter-spacing: -0.3px; }
  .sub { color: var(--muted); margin: 0 0 36px; font-size: 17px; }
  .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 18px; }
  @media (max-width: 860px) { .grid { grid-template-columns: repeat(2, 1fr); } }
  @media (max-width: 560px) { .grid { grid-template-columns: 1fr; } }
  .card { background: var(--bg); border: 1px solid var(--line); border-radius: 18px; padding: 22px; }
  section:not(.alt) .card { background: var(--surface); }
  .card .ic { font-size: 28px; }
  .card h3 { margin: 8px 0 6px; font-size: 18px; }
  .card p { margin: 0; color: var(--muted); font-size: 15px; }
  .card code, .step code, .faq code { background: var(--green-soft); color: var(--green-ink); padding: 1px 6px; border-radius: 6px; font-size: 13px; font-family: ui-monospace, Menlo, Consolas, monospace; }

  .steps { display: grid; grid-template-columns: repeat(3, 1fr); gap: 18px; counter-reset: s; }
  @media (max-width: 760px) { .steps { grid-template-columns: 1fr; } }
  .step { position: relative; padding: 22px 22px 22px 70px; background: var(--surface); border: 1px solid var(--line); border-radius: 18px; }
  .step::before { counter-increment: s; content: counter(s); position: absolute; left: 20px; top: 20px; width: 34px; height: 34px; border-radius: 50%; background: var(--green); color: #fff; font-weight: 800; display: grid; place-items: center; }
  .step h3 { margin: 0 0 4px; font-size: 17px; }
  .step p { margin: 0; color: var(--muted); font-size: 15px; }

  .plans { display: grid; grid-template-columns: repeat(3, 1fr); gap: 18px; align-items: stretch; }
  @media (max-width: 860px) { .plans { grid-template-columns: 1fr; max-width: 460px; margin-inline: auto; } }
  .plan { display: flex; flex-direction: column; background: var(--bg); border: 1px solid var(--line); border-radius: 20px; padding: 26px; }
  .plan.featured { border: 2px solid var(--green); position: relative; box-shadow: 0 16px 40px rgba(6,199,85,.15); }
  .plan.featured::before { content: "推薦"; position: absolute; top: -13px; left: 24px; background: var(--green); color: #fff; font-size: 12px; font-weight: 700; padding: 3px 12px; border-radius: 999px; }
  .plan h3 { margin: 0; font-size: 20px; }
  .price { margin: 12px 0 4px; font-size: 40px; font-weight: 800; letter-spacing: -1px; }
  .price small { font-size: 15px; font-weight: 500; color: var(--muted); letter-spacing: 0; }
  .plan .for { color: var(--muted); font-size: 14px; margin: 0 0 16px; }
  .plan ul { list-style: none; padding: 0; margin: 0 0 22px; flex: 1; font-size: 15px; }
  .plan li { padding: 6px 0; border-top: 1px dashed var(--line); }
  .plan li.off { color: var(--muted); }
  .plan .btn { justify-content: center; }
  .note { text-align: center; color: var(--muted); font-size: 14px; margin-top: 22px; }

  .faq { max-width: 760px; }
  details { background: var(--surface); border: 1px solid var(--line); border-radius: 14px; padding: 4px 20px; margin-bottom: 10px; }
  summary { cursor: pointer; font-weight: 700; padding: 14px 0; list-style: none; }
  summary::-webkit-details-marker { display: none; }
  summary::after { content: "＋"; float: right; color: var(--muted); }
  details[open] summary::after { content: "－"; }
  details p { margin: 0 0 16px; color: var(--muted); }

  .final { text-align: center; padding-block: 72px; }
  .final h2 { margin-bottom: 12px; }
  .final .cta { justify-content: center; margin-top: 24px; }
  footer { border-top: 1px solid var(--line); padding-block: 28px calc(28px + env(safe-area-inset-bottom, 0px)); color: var(--muted); font-size: 14px; }
  footer .wrap { display: flex; justify-content: space-between; flex-wrap: wrap; gap: 12px; }
</style>
</head>
<body>
<header>
  <div class="wrap">
    <a class="brand" href="#top"><i>${esc(SITE.mark)}</i>${name} <small>${esc(SITE.tagline)}</small></a>
    <nav><a href="#features">功能</a><a href="#how">開始使用</a><a href="#pricing">方案</a><a href="#faq">常見問題</a></nav>
    <a class="btn small" href="${join}">加入 LINE 洽詢</a>
  </div>
</header>

<main id="top">
  <div class="wrap hero">
    <div>
      <span class="eyebrow">給工地、工廠、外籍同事一起工作的團隊</span>
      <h1>LINE 群組裡<br><em>說不同語言</em>，<br>也能把事情做完</h1>
      <p class="lead">把${name}拉進你們原本的 LINE 群組：每則訊息自動翻成大家看得懂的語言，任務指派、完成回報、工具材料數量都在聊天裡完成，月底一鍵匯出報表。</p>
      <div class="cta">
        <a class="btn" href="${join}">💬 加入 LINE 免費開始</a>
        <a class="btn ghost" href="#pricing">看訂閱方案</a>
      </div>
      <p class="langs">支援 ${langList(Object.keys(LANGUAGES))}</p>
      <p class="langs">📜 ${esc(SITE.story)}</p>
    </div>

    <div class="phone" role="img" aria-label="群組對話示意：中文與越南文自動互譯、新增任務、完成回報">
      <div class="top">🏗️ 南港工地群組（12）</div>
      <div class="msg"><div class="av" style="background:#e07a3f">明</div><div><div class="who">阿明</div><div class="b">明天早上七點工地集合，記得帶安全帽</div></div></div>
      <div class="msg"><div class="av" style="background:var(--green)">${esc(SITE.mark)}</div><div><div class="who">${name}</div><div class="b bot">🌐 阿明<br>🇻🇳 Sáng mai 7 giờ tập trung tại công trường, nhớ mang mũ bảo hộ.<br>🇺🇸 Meet at the site at 7am tomorrow, bring your helmet.</div></div></div>
      <div class="msg"><div class="av" style="background:#7a5ad6">T</div><div><div class="who">Tuấn</div><div class="b">Dạ, em sẽ mang thêm máy cưa.</div></div></div>
      <div class="msg"><div class="av" style="background:var(--green)">${esc(SITE.mark)}</div><div><div class="who">${name}</div><div class="b bot">🌐 Tuấn：好的，我會多帶一台鋸子。</div></div></div>
      <div class="msg me"><div class="b">/add 租鷹架 @Tuấn 10/20</div></div>
      <div class="msg"><div class="av" style="background:var(--green)">${esc(SITE.mark)}</div><div><div class="who">${name}</div><div class="b bot">➕ #3 租鷹架 / Thuê giàn giáo<small>👤 Tuấn　⏰ 10/20　[未開始]</small></div></div></div>
      <div class="chips"><span>🌐 翻譯</span><span>📋 任務</span><span>🔧 工具</span><span>🧱 材料</span><span>📱 選單</span></div>
    </div>
  </div>

  <section class="alt" id="features">
    <div class="wrap">
      <h2>一個群組，六件事一次搞定</h2>
      <p class="sub">不用另外裝 App、不用教大家新系統，大家照樣在 LINE 聊天。</p>
      <div class="grid">
        <div class="card"><div class="ic">🌐</div><h3>自動多語翻譯</h3><p>中、英、越、印、泰、菲、日文互譯，每則訊息翻成群組選的所有語言，附上發言者名字。可設定專有名詞，例如「收頭樑 = trimmer beam」。</p></div>
        <div class="card"><div class="ic">📋</div><h3>任務與完成回報</h3><p><code>/add 租鷹架 @阿明 10/20</code> 一行指派。點「完成」要回報現況，例如「租到 2 台，週五可取」；做不成就標「失敗」並寫原因。</p></div>
        <div class="card"><div class="ic">🔧</div><h3>工具、材料數量表</h3><p><code>/tool 線鋸 1</code>、<code>/material 螺絲 100</code> 新增或累加，清單卡片上按 −1／+1 調整。用越南文打名字也會算到同一項。</p></div>
        <div class="card"><div class="ic">📊</div><h3>一鍵匯出報表</h3><p><code>/report</code> 產生報表連結：完成、失敗、逾期統計與明細，下載 Excel 可開的 CSV，或直接列印成 PDF。</p></div>
        <div class="card"><div class="ic">👆</div><h3>手機點一下就好</h3><p>輸入框上方常備按鈕、任務卡片上的「開始／完成」，<code>/template</code> 還有可以複製的指令範本，工地現場不用打一長串字。</p></div>
        <div class="card"><div class="ic">⚙️</div><h3>在 LINE 裡設定</h3><p>管理員輸入 <code>/settings</code> 就能開設定頁：選語言、開關功能、編輯詞彙表、看本月用量，不用碰電腦。</p></div>
      </div>
    </div>
  </section>

  <section id="how">
    <div class="wrap">
      <h2>三步驟開始使用</h2>
      <p class="sub">五分鐘內，群組就會開始翻譯。</p>
      <div class="steps">
        <div class="step"><h3>加入 LINE 好友</h3><p>加 <code>${esc(SITE.lineId)}</code> 為好友，告訴我們你的團隊，取得一組啟用碼。</p></div>
        <div class="step"><h3>拉進你的群組</h3><p>把${name}邀請進原本的工作群組，不用另外建新群組。</p></div>
        <div class="step"><h3>輸入啟用碼</h3><p>在群組輸入 <code>/activate 啟用碼</code>，輸入的人就是管理員，馬上開始使用。</p></div>
      </div>
    </div>
  </section>

  <section class="alt" id="pricing">
    <div class="wrap">
      <h2>訂閱方案</h2>
      <p class="sub">以群組計價，先免費試用，需要更多語言再升級。</p>
      <div class="plans">
        <div class="plan">
          <h3>免費</h3>
          <div class="price">NT$0 <small>／群組／月</small></div>
          <p class="for">小團隊、中英文溝通</p>
          <ul>
            ${check(`每月翻譯 ${fmt(free.monthlyChars)} 字（${asMessages(free.monthlyChars)}）`)}
            ${check(`${free.languages.length} 種語言：${langList(free.languages)}`)}
            ${check("任務、完成回報、工具材料數量")}
            ${check("報表匯出 CSV／PDF")}
            ${check("每週一推播進度摘要", free.digest)}
            ${check("越南文、印尼文、泰文等東南亞語言", false)}
            ${check("AI 助理：@機器人用說的就能操作", free.ai)}
          </ul>
          <a class="btn ghost" href="${join}">免費開始</a>
        </div>
        <div class="plan featured">
          <h3>專業版</h3>
          <div class="price">NT$${fmt(pro.price)} <small>／群組／月</small></div>
          <p class="for">有外籍同事的工地、工廠</p>
          <ul>
            ${check(`每月翻譯 ${fmt(pro.monthlyChars)} 字（${asMessages(pro.monthlyChars)}）`)}
            ${check(`全部 ${pro.languages.length} 種語言`)}
            ${check("任務、完成回報、工具材料數量")}
            ${check("報表匯出 CSV／PDF")}
            ${check("每週一推播進度摘要", pro.digest)}
            ${check("AI 助理：@機器人用說的就能操作，任何語言都可以", pro.ai)}
            ${check("專有名詞詞彙表（Claude 引擎）")}
          </ul>
          <a class="btn" href="${join}">升級專業版</a>
        </div>
        <div class="plan">
          <h3>企業白牌</h3>
          <div class="price" style="font-size:30px">${esc(SITE.enterprisePrice)}</div>
          <p class="for">想用自己品牌與官方帳號的公司</p>
          <ul>
            ${check("使用貴公司自己的 LINE 官方帳號與名稱")}
            ${check("群組數量、翻譯額度依需求規劃")}
            ${check("專屬啟用碼，控管哪些群組能使用")}
            ${check("專屬詞彙表與功能客製")}
          </ul>
          <a class="btn ghost" href="${join}">聯絡我們</a>
        </div>
      </div>
      <p class="note">付款方式為轉帳，收款後由我們為群組開通方案。</p>
    </div>
  </section>

  <section id="faq">
    <div class="wrap faq">
      <h2>常見問題</h2>
      <p class="sub">還有其他問題？加 LINE 好友直接問我們。</p>
      <details><summary>群組成員需要另外安裝或註冊什麼嗎？</summary><p>不需要。大家照常在 LINE 群組聊天，只有管理員需要在 LINE 裡開設定頁。</p></details>
      <details><summary>翻譯額度用完會怎樣？</summary><p>自動翻譯會暫停並在群組提示一次，任務、工具材料照常可用；下個月 1 日（台北時間）自動恢復，也可以隨時升級專業版。</p></details>
      <details><summary>不想每句都翻譯可以嗎？</summary><p>可以。輸入 <code>/translate off</code> 關閉自動翻譯，需要時再用 <code>/t 文字</code> 只翻那一句；也可以在設定頁改成「只翻 /t」。</p></details>
      <details><summary>聊天內容會被保存嗎？</summary><p>翻譯時訊息會送到翻譯服務，但我們不保存聊天原文；只保存任務、工具材料、報表等你們主動建立的資料。建議開始前先告知群組成員。</p></details>
      <details><summary>電腦版 LINE 可以用嗎？</summary><p>可以。電腦版看不到輸入框上方的快速按鈕，輸入 <code>/menu</code> 會出現一張功能選單卡片，按鈕一樣能點。</p></details>
      <details><summary>一個帳號可以用在幾個群組？</summary><p>方案以群組計算，每個群組各用一組啟用碼開通。多個群組或公司導入，歡迎聯絡我們規劃企業方案。</p></details>
    </div>
  </section>

  <section class="alt final">
    <div class="wrap">
      <h2>今天就讓群組開始說同一種語言</h2>
      <p class="sub" style="margin:0">免費開始，不用信用卡。</p>
      <div class="cta"><a class="btn" href="${join}">💬 加入 LINE：${esc(SITE.lineId)}</a></div>
    </div>
  </section>
</main>

<footer>
  <div class="wrap">
    <span>© ${new Date().getUTCFullYear()} ${name}・${esc(SITE.tagline)}</span>
    <span>洽詢：LINE ${esc(SITE.lineId)}</span>
  </div>
</footer>
</body>
</html>`;
}
