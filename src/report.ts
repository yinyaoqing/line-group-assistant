import { signToken, verifyToken } from "./core/crypto";
import type { GroupConfig } from "./core/types";
import { isOpen, STATUS } from "./plugins/tasks";
import { translationsOf } from "./plugins/translate/terms";
import type { Row, Storage } from "./storage/types";

/**
 * Task and item report for one group: an HTML page (summary, tables, print to
 * PDF) and CSV downloads, behind a signed link that lasts REPORT_TTL_SECONDS.
 *
 *   GET /report/<token>             the page
 *   GET /report/<token>/tasks.csv   tasks, UTF-8 with BOM so Excel reads Chinese
 *   GET /report/<token>/tools.csv   tools; materials.csv likewise
 */
export const REPORT_TTL_SECONDS = 24 * 3600;

/** A signed report link; `?openExternalBrowser=1` makes LINE open it outside its in-app browser, where downloads work. */
export async function reportUrl(secret: string, origin: string, groupId: string): Promise<string> {
  const token = await signToken(secret, "report", { g: groupId }, REPORT_TTL_SECONDS);
  return `${origin}/report/${token}?openExternalBrowser=1`;
}

export const verifyReportToken = (secret: string, token: string) => verifyToken<{ g: string }>(secret, "report", token);


/** "2026-10-16T02:30:00Z" → "2026-10-16 10:30" in Taipei time. */
export const taipeiTime = (iso: string | undefined) => {
  if (!iso) return "";
  const t = new Date(iso);
  return Number.isNaN(t.getTime()) ? iso : new Date(t.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 16).replace("T", " ");
};

/**
 * End of the due day in Taipei, from "10/17", "10-17" or "2026/10/17". A date
 * without a year is taken in the current Taipei year. Undefined if unreadable.
 */
export function dueDate(due: string | undefined, now = new Date()): Date | undefined {
  const m = due?.trim().match(/^(?:(\d{4})[/-])?(\d{1,2})[/-](\d{1,2})$/);
  if (!m) return undefined;
  const year = m[1] ? Number(m[1]) : new Date(now.getTime() + 8 * 3600 * 1000).getUTCFullYear();
  const end = new Date(Date.UTC(year, Number(m[2]) - 1, Number(m[3]), 23, 59, 59, 999) - 8 * 3600 * 1000);
  return Number.isNaN(end.getTime()) ? undefined : end;
}

/** Count lists in the report, by plugin (= table) name, in display order. */
const COUNTERS = [
  { key: "tools", title: "🔧 工具 Tools", noun: "工具" },
  { key: "materials", title: "🧱 材料 Materials", noun: "材料" },
] as const;

export type CounterKey = (typeof COUNTERS)[number]["key"];

export interface CounterSection {
  key: CounterKey;
  title: string;
  noun: string;
  rows: Row[];
  /** Number of entries and the sum of their counts. */
  kinds: number;
  total: number;
}

export interface ReportData {
  group: GroupConfig;
  generatedAt: string;
  tasks: Row[];
  /** Only the count lists the group has turned on. */
  counters: CounterSection[];
  summary: { total: number; done: number; failed: number; doing: number; todo: number; overdue: number };
}

export async function buildReport(group: GroupConfig, storage: Storage, now = new Date()): Promise<ReportData> {
  const plugins = new Set(group.plugins);
  const tasks = plugins.has("tasks") ? await storage.list("tasks") : [];
  const counters = await Promise.all(
    COUNTERS.filter((c) => plugins.has(c.key)).map(async (c) => {
      const rows = (await storage.list(c.key)).filter((r) => r.removed !== "1").sort((a, b) => (a.name ?? "").localeCompare(b.name ?? "", "zh-Hant"));
      return { ...c, rows, kinds: rows.length, total: rows.reduce((n, r) => n + (Number(r.qty) || 0), 0) };
    }),
  );
  const isOverdue = (r: Row) => isOpen(r) && (dueDate(r.due, now)?.getTime() ?? Infinity) < now.getTime();
  return {
    group,
    generatedAt: now.toISOString(),
    tasks,
    counters,
    summary: {
      total: tasks.length,
      done: tasks.filter((r) => r.status === STATUS.done).length,
      failed: tasks.filter((r) => r.status === STATUS.failed).length,
      doing: tasks.filter((r) => r.status === STATUS.doing).length,
      todo: tasks.filter((r) => isOpen(r) && r.status !== STATUS.doing).length,
      overdue: tasks.filter(isOverdue).length,
    },
  };
}

/** One-paragraph summary for the chat reply. */
export function summaryText(d: ReportData): string {
  const s = d.summary;
  const lines = [`📊 報表 Report：${d.group.name ?? "群組"}`];
  if (d.group.plugins.includes("tasks")) {
    lines.push(`📋 任務 ${s.total}：完成 ${s.done}${s.failed ? `、失敗 ${s.failed}` : ""}、進行中 ${s.doing}、未開始 ${s.todo}${s.overdue ? `、⚠️ 逾期 ${s.overdue}` : ""}`);
  }
  for (const c of d.counters) lines.push(`${c.title.split(" ")[0]} ${c.noun} ${c.kinds} 項，共 ${c.total} 件`);
  return lines.join("\n");
}

// ---------- CSV ----------

const TASK_COLUMNS: [string, (r: Row) => string][] = [
  ["編號", (r) => r.id],
  ["標題", (r) => r.title ?? ""],
  ["翻譯", (r) => translationsOf(r.i18n).join(" / ")],
  ["狀態", (r) => r.status ?? ""],
  ["負責人", (r) => r.owner ?? ""],
  ["期限", (r) => r.due ?? ""],
  ["建立者", (r) => r.createdBy ?? ""],
  ["建立時間", (r) => taipeiTime(r.createdAt)],
  ["完成回報／失敗原因", (r) => (r.status === STATUS.failed ? r.failReason ?? "" : r.status === STATUS.done ? r.report ?? "" : "")],
  ["結束時間", (r) => taipeiTime(r.status === STATUS.failed ? r.failedAt : r.status === STATUS.done ? r.doneAt : undefined)],
];

const ITEM_COLUMNS: [string, (r: Row) => string][] = [
  ["名稱", (r) => r.name ?? ""],
  ["翻譯", (r) => translationsOf(r.i18n).join(" / ")],
  ["數量", (r) => r.qty ?? "0"],
  ["最後修改者", (r) => r.updatedBy ?? ""],
  ["最後修改時間", (r) => taipeiTime(r.updatedAt)],
];

/**
 * RFC 4180 CSV with a BOM. Cells starting with = + - @ get a leading quote mark
 * so a spreadsheet does not run them as formulas.
 */
export function toCsv(rows: Row[], columns: [string, (r: Row) => string][]): string {
  const cell = (v: string) => {
    const safe = /^[=+\-@\t\r]/.test(v) && !/^-?\d+(\.\d+)?$/.test(v) ? `'${v}` : v;
    return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  const lines = [columns.map(([h]) => cell(h)).join(","), ...rows.map((r) => columns.map(([, get]) => cell(get(r))).join(","))];
  return "﻿" + lines.join("\r\n") + "\r\n";
}

export const tasksCsv = (d: ReportData) => toCsv(d.tasks, TASK_COLUMNS);
export const counterCsv = (d: ReportData, key: CounterKey) => toCsv(d.counters.find((c) => c.key === key)?.rows ?? [], ITEM_COLUMNS);

// ---------- HTML ----------

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function table(kind: "tasks" | "counts", rows: Row[], columns: [string, (r: Row) => string][], rowClass: (r: Row) => string = () => ""): string {
  if (!rows.length) return `<p class="muted">沒有資料 No data</p>`;
  const head = columns.map(([h]) => `<th>${esc(h)}</th>`).join("");
  const body = rows.map((r) => `<tr class="${rowClass(r)}">${columns.map(([, get]) => `<td>${esc(get(r))}</td>`).join("")}</tr>`).join("");
  return `<div class="scroll"><table class="${kind}"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

export function reportHtml(d: ReportData, token: string): string {
  const s = d.summary;
  const name = esc(d.group.name ?? "群組");
  const now = new Date(d.generatedAt);
  const taskClass = (r: Row) =>
    r.status === STATUS.failed ? "failed" : r.status === STATUS.done ? "done" : (dueDate(r.due, now)?.getTime() ?? Infinity) < now.getTime() ? "late" : "";
  const hasTasks = d.group.plugins.includes("tasks");
  const stat = (label: string, value: number, cls = "") => `<div class="stat ${cls}"><b>${value}</b><span>${label}</span></div>`;
  const base = `/report/${encodeURIComponent(token)}`;

  return `<!doctype html>
<html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex"><title>${name} 報表</title>
<style>
  :root { --bg:#f5f6f8; --card:#fff; --text:#1d2129; --muted:#6b7280; --line:#e5e7eb; --accent:#06c755; --warn:#b45309; --warn-bg:#fef3c7; color-scheme: light; }
  @media (prefers-color-scheme: dark) { :root { --bg:#111315; --card:#1b1e21; --text:#e8eaed; --muted:#9aa0a6; --line:#2c3034; --warn:#fbbf24; --warn-bg:#3a2e0b; color-scheme: dark; } }
  * { box-sizing: border-box; }
  body { margin:0; font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans TC","PingFang TC",sans-serif; background:var(--bg); color:var(--text); }
  main { max-width:960px; margin:0 auto; padding:16px 16px calc(32px + env(safe-area-inset-bottom,0px)); }
  h1 { font-size:20px; margin:4px 0 2px; } h2 { font-size:16px; margin:0 0 12px; }
  .muted { color:var(--muted); font-size:13px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:14px; padding:16px; margin-top:12px; }
  .stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(76px,1fr)); gap:8px; margin-bottom:12px; }
  .stat { border:1px solid var(--line); border-radius:10px; padding:10px; text-align:center; }
  .stat b { display:block; font-size:22px; } .stat span { color:var(--muted); font-size:12px; }
  .stat.warn { border-color:var(--warn); color:var(--warn); } .stat.bad { border-color:#dc2626; color:#dc2626; }
  .actions { display:flex; flex-wrap:wrap; gap:8px; margin-top:12px; }
  .btn { display:inline-block; padding:9px 14px; border-radius:10px; background:var(--accent); color:#fff; text-decoration:none; font-weight:600; border:0; font:inherit; cursor:pointer; }
  .btn.ghost { background:transparent; color:var(--text); border:1px solid var(--line); font-weight:400; }
  .scroll { overflow-x:auto; }
  table { border-collapse:collapse; width:100%; font-size:13px; }
  th, td { text-align:left; padding:8px 6px; border-bottom:1px solid var(--line); white-space:nowrap; }
  th { color:var(--muted); font-weight:500; }
  table.tasks td:nth-child(2), table.tasks td:nth-child(3), table.counts td:nth-child(1), table.counts td:nth-child(2) { white-space:normal; min-width:7em; }
  tr.late td { background:var(--warn-bg); } tr.done td { color:var(--muted); } tr.failed td { color:#dc2626; } tr.empty td:nth-child(3) { color:#dc2626; font-weight:600; }
  @media print {
    :root { --bg:#fff; --card:#fff; --text:#000; --muted:#555; --line:#ccc; color-scheme: light; }
    .actions, .noprint { display:none !important; } .card { border:0; padding:0; } main { max-width:none; padding:0; }
    th, td { white-space:normal; }
  }
</style></head><body><main>
  <h1>📊 ${name}</h1>
  <p class="muted">產生時間 ${esc(taipeiTime(d.generatedAt))}（台北時間）<span class="noprint"> · 連結 24 小時內有效</span></p>
  ${
    hasTasks
      ? `<div class="card"><h2>📋 任務 Tasks</h2>
    <div class="stats">${stat("全部", s.total)}${stat("完成", s.done)}${stat("失敗", s.failed, s.failed ? "bad" : "")}${stat("進行中", s.doing)}${stat("未開始", s.todo)}${stat("逾期", s.overdue, s.overdue ? "warn" : "")}</div>
    ${table("tasks", d.tasks, TASK_COLUMNS, taskClass)}
    <div class="actions"><a class="btn" href="${base}/tasks.csv">⬇ 下載任務 CSV</a></div></div>`
      : ""
  }
  ${d.counters
    .map(
      (c) => `<div class="card"><h2>${esc(c.title)}</h2>
    <div class="stats">${stat("品項", c.kinds)}${stat("總件數", c.total)}</div>
    ${table("counts", c.rows, ITEM_COLUMNS, (r) => (Number(r.qty) > 0 ? "" : "empty"))}
    <div class="actions"><a class="btn" href="${base}/${c.key}.csv">⬇ 下載${esc(c.noun)} CSV</a></div></div>`,
    )
    .join("\n  ")}
  ${!hasTasks && !d.counters.length ? `<div class="card"><p class="muted">這個群組沒有開啟任務、工具或材料功能。</p></div>` : ""}
  <div class="actions"><button class="btn ghost" onclick="window.print()">🖨 列印／存成 PDF</button></div>
</main></body></html>`;
}

/** Serve /report/<token>[/tasks.csv|/tools.csv|/materials.csv]; undefined if the path is not a report path. */
export async function handleReport(
  path: string,
  secret: string | undefined,
  load: (groupId: string) => Promise<{ group: GroupConfig; storage: Storage } | undefined>,
): Promise<Response | undefined> {
  const m = path.match(/^\/report\/([^/]+)(?:\/(tasks|tools|materials)\.csv)?$/);
  if (!m) return undefined;
  const page = (msg: string, status: number) =>
    new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><p style="font:16px sans-serif;padding:24px">${esc(msg)}</p>`, {
      status,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  const token = decodeURIComponent(m[1]!);
  const claims = secret ? await verifyReportToken(secret, token) : undefined;
  if (!claims) return page("報表連結已過期，請在群組重新輸入 /report。 This report link has expired.", 410);
  const found = await load(claims.g);
  if (!found) return page("找不到群組 Group not found", 404);

  const data = await buildReport(found.group, found.storage);
  const headers = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex", "Referrer-Policy": "no-referrer" };
  if (m[2]) {
    const csv = m[2] === "tasks" ? tasksCsv(data) : counterCsv(data, m[2] as CounterKey);
    const day = taipeiTime(data.generatedAt).slice(0, 10);
    const file = `${m[2]}-${day}.csv`;
    return new Response(csv, {
      headers: { ...headers, "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${file}"` },
    });
  }
  return new Response(reportHtml(data, token), { headers: { ...headers, "Content-Type": "text/html; charset=utf-8" } });
}
