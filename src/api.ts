import { isLangCode, LANGUAGES } from "../config/languages";
import { effectivePlan, PLANS, UPGRADE_NOTE, type PlanId } from "../config/plans";
import { encrypt, verifyToken, signToken } from "./core/crypto";
import type { LineApi } from "./core/line";
import type { Env, GroupConfig, Plugin } from "./core/types";
import { monthlyLimit, groupLanguages, USAGE_METRIC } from "./plugins/translate";
import type { AdminRepo } from "./storage/admins";
import type { ChannelRepo } from "./storage/channels";
import { formatCode, type CodeRepo } from "./storage/codes";
import type { GroupRepo, UsageMeter } from "./storage/groups";
import type { Storage } from "./storage/types";
import { buildReport, reportUrl, summaryText } from "./report";

/**
 * JSON API behind the settings page (src/app/index.html).
 *
 *   POST /api/session                 LINE Login ID token (+ /settings link) → session token
 *   GET  /api/me                      the signed-in account and the groups it administers
 *   GET  /api/groups/:id              one group's settings, plan and usage
 *   PUT  /api/groups/:id/settings     change what group admins may change
 *   POST /api/groups/:id/report       a 24-hour report link (page + CSV)
 *   GET  /api/admin/groups            platform admins: every group
 *   PUT  /api/admin/groups/:id        platform admins: plan, status, engine, quota
 *   GET|POST /api/admin/channels      platform admins: white-label channels
 *   DELETE /api/admin/channels/:id
 *   GET|POST /api/admin/codes          platform admins: one-time activation codes
 *   DELETE /api/admin/codes/:code      revoke an unused code
 */
export interface ApiDeps {
  env: Env;
  groups: GroupRepo;
  admins: AdminRepo;
  channels: ChannelRepo;
  codes: CodeRepo;
  usage: UsageMeter;
  plugins: Record<string, Plugin>;
  lineFor(channelId: string): Promise<LineApi | undefined>;
  /** Verify a LINE Login ID token; returns the account, or undefined if invalid. */
  verifyIdToken(idToken: string): Promise<{ sub: string; name?: string } | undefined>;
  /** Base URL of this Worker, for white-label webhook URLs and report links. */
  origin: string;
  storageFor(group: GroupConfig): Storage;
}

const SESSION_TTL_SECONDS = 12 * 3600;

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });

export async function handleApi(req: Request, deps: ApiDeps): Promise<Response> {
  try {
    return await route(req, deps);
  } catch (err) {
    if (err instanceof HttpError) return json({ error: err.message }, err.status);
    console.error("api failed", err);
    return json({ error: "伺服器錯誤 Server error" }, 500);
  }
}

async function route(req: Request, deps: ApiDeps): Promise<Response> {
  const secret = deps.env.APP_SECRET;
  if (!secret) throw new HttpError(503, "APP_SECRET 未設定");
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, "");
  const m = (re: RegExp) => path.match(re);
  const body = async <T>() => (await req.json().catch(() => ({}))) as T;

  if (req.method === "POST" && path === "/api/session") return session(await body<SessionBody>(), deps, secret);

  const me = await verifyToken<{ sub: string; name?: string }>(secret, "session", req.headers.get("Authorization")?.replace(/^Bearer /, ""));
  if (!me) throw new HttpError(401, "請重新登入 Please sign in again");
  const platformAdmin = (deps.env.PLATFORM_ADMINS ?? "").split(",").map((s) => s.trim()).includes(me.sub);

  if (req.method === "GET" && path === "/api/me") {
    const mine = await deps.admins.groupsForLogin(me.sub);
    const groups = await Promise.all(
      mine.map(async (a) => {
        const g = await deps.groups.get(a.groupId);
        return g && { groupId: g.groupId, name: g.name, status: g.status, plan: effectivePlan(g.plan, g.planUntil).id, role: a.role };
      }),
    );
    return json({ sub: me.sub, name: me.name, platformAdmin, groups: groups.filter(Boolean) });
  }

  let g = m(/^\/api\/groups\/([^/]+)$/);
  if (g && req.method === "GET") return json(await groupView(await allowedGroup(g[1]!, me.sub, platformAdmin, deps), deps));

  g = m(/^\/api\/groups\/([^/]+)\/settings$/);
  if (g && req.method === "PUT") {
    const group = await allowedGroup(g[1]!, me.sub, platformAdmin, deps);
    const updated = await deps.groups.update(group.groupId, applySettings(group, await body<SettingsBody>(), deps.plugins));
    return json(await groupView(updated!, deps));
  }

  g = m(/^\/api\/groups\/([^/]+)\/report$/);
  if (g && req.method === "POST") {
    const group = await allowedGroup(g[1]!, me.sub, platformAdmin, deps);
    const data = await buildReport(group, deps.storageFor(group));
    return json({ url: await reportUrl(secret, deps.origin, group.groupId), summary: summaryText(data) });
  }

  if (path.startsWith("/api/admin/")) {
    if (!platformAdmin) throw new HttpError(403, "需要平台管理員權限 Platform admins only");
    return adminRoute(req, path, body, deps, secret);
  }

  throw new HttpError(404, "not found");
}

// ---------- session ----------

interface SessionBody {
  idToken?: string;
  link?: string;
  /** DEV_MODE only: sign in as this account without LINE Login. */
  devSub?: string;
}

async function session(b: SessionBody, deps: ApiDeps, secret: string): Promise<Response> {
  let account: { sub: string; name?: string } | undefined;
  if (deps.env.DEV_MODE === "1" && b.devSub) account = { sub: b.devSub, name: `Dev ${b.devSub}` };
  else if (b.idToken) account = await deps.verifyIdToken(b.idToken);
  if (!account) throw new HttpError(401, "LINE 登入驗證失敗 LINE sign-in failed");

  let groupId: string | undefined;
  if (b.link) {
    const link = await verifyToken<{ g: string; u: string; n: string }>(secret, "link", b.link);
    if (!link) throw new HttpError(400, "連結已過期，請在群組重新輸入 /settings\nThe link has expired; send /settings again.");
    if (!(await deps.admins.consumeNonce(link.n))) {
      // A reload of the same page is fine once the account is already bound.
      const bound = (await deps.admins.groupsForLogin(account.sub)).some((a) => a.groupId === link.g);
      if (!bound) throw new HttpError(400, "連結已使用過，請重新輸入 /settings\nThis link was already used; send /settings again.");
    } else {
      const res = await deps.admins.bindLogin(link.g, link.u, account.sub);
      if (res === "missing") throw new HttpError(403, "你已不是這個群組的管理員 You are no longer an admin of this group");
      if (res === "conflict") throw new HttpError(403, "這個管理員身分已綁定其他 LINE 帳號 This admin is linked to another LINE account");
    }
    groupId = link.g;
  }

  const token = await signToken(secret, "session", { sub: account.sub, name: account.name }, SESSION_TTL_SECONDS);
  return json({ session: token, sub: account.sub, name: account.name, groupId });
}

// ---------- groups ----------

async function allowedGroup(groupId: string, sub: string, platformAdmin: boolean, deps: ApiDeps): Promise<GroupConfig> {
  const group = await deps.groups.get(groupId);
  if (!group) throw new HttpError(404, "找不到群組 Group not found");
  if (!platformAdmin && !(await deps.admins.groupsForLogin(sub)).some((a) => a.groupId === groupId)) {
    throw new HttpError(403, "你不是這個群組的管理員 Not an admin of this group");
  }
  return group;
}

async function groupView(group: GroupConfig, deps: ApiDeps) {
  const plan = effectivePlan(group.plan, group.planUntil);
  const t = group.settings?.translate ?? {};
  const line = await deps.lineFor(group.channelId ?? "default").catch(() => undefined);
  const admins = await Promise.all(
    (await deps.admins.list(group.groupId)).map(async (a) => ({
      role: a.role,
      linked: !!a.loginSub,
      name: (line && (await line.groupMemberName(group.groupId, a.lineUserId).catch(() => undefined))) ?? a.lineUserId.slice(0, 8),
    })),
  );
  return {
    groupId: group.groupId,
    name: group.name,
    status: group.status,
    channelId: group.channelId,
    plan: { ...plan, until: plan.id === "free" ? undefined : group.planUntil },
    planId: group.plan ?? "free",
    plans: Object.values(PLANS),
    upgradeNote: UPGRADE_NOTE,
    plugins: group.plugins,
    availablePlugins: Object.keys(deps.plugins),
    translate: {
      languages: groupLanguages(t, plan),
      trigger: t.trigger ?? "all",
      showName: t.showName !== false,
      minLength: Number(t.minLength ?? 2),
      glossary: typeof t.glossary === "string" ? t.glossary : "",
      engine: t.engine ?? "google",
      monthlyChars: typeof t.monthlyChars === "number" ? t.monthlyChars : null,
    },
    tasks: { digest: group.settings?.tasks?.digest === true },
    usage: { translateChars: await deps.usage.get(group.groupId, USAGE_METRIC), limit: monthlyLimit(t, plan) },
    languages: Object.entries(LANGUAGES).map(([code, l]) => ({ code, name: l.name, flag: l.flag, allowed: plan.languages.includes(code as never) })),
    admins,
  };
}

interface SettingsBody {
  plugins?: unknown;
  translate?: { languages?: unknown; trigger?: unknown; showName?: unknown; minLength?: unknown; glossary?: unknown };
  tasks?: { digest?: unknown };
}

/** What group admins may change. Engine and quota stay with platform admins. */
export function applySettings(group: GroupConfig, b: SettingsBody, plugins: Record<string, Plugin>) {
  const plan = effectivePlan(group.plan, group.planUntil);
  const settings = structuredClone(group.settings ?? {});
  const t = (settings.translate ??= {});
  const patch: { plugins?: string[]; settings: NonNullable<GroupConfig["settings"]> } = { settings };

  if (b.plugins !== undefined) {
    if (!Array.isArray(b.plugins) || !b.plugins.every((p) => typeof p === "string" && p in plugins)) throw new HttpError(400, "未知的功能 Unknown plugin");
    patch.plugins = [...new Set(b.plugins as string[])];
  }
  const bt = b.translate;
  if (bt?.languages !== undefined) {
    if (!Array.isArray(bt.languages) || !bt.languages.every(isLangCode)) throw new HttpError(400, "未知的語言 Unknown language");
    const langs = [...new Set(bt.languages)];
    if (langs.length < 2) throw new HttpError(400, "至少選兩種語言 Choose at least two languages");
    const blocked = langs.filter((l) => !plan.languages.includes(l));
    if (blocked.length) throw new HttpError(403, `目前方案不含：${blocked.map((l) => LANGUAGES[l].name).join("、")}\nNot in your plan.`);
    t.languages = langs;
  }
  if (bt?.trigger !== undefined) {
    if (bt.trigger !== "all" && bt.trigger !== "command") throw new HttpError(400, "trigger 只能是 all 或 command");
    t.trigger = bt.trigger;
  }
  if (bt?.showName !== undefined) t.showName = bt.showName === true;
  if (bt?.minLength !== undefined) {
    const n = Number(bt.minLength);
    if (!Number.isInteger(n) || n < 1 || n > 50) throw new HttpError(400, "最短長度需為 1–50");
    t.minLength = n;
  }
  if (bt?.glossary !== undefined) {
    if (typeof bt.glossary !== "string" || bt.glossary.length > 2000) throw new HttpError(400, "詞彙表最多 2000 字");
    t.glossary = bt.glossary.trim();
  }
  if (b.tasks?.digest !== undefined) {
    if (b.tasks.digest === true && !plan.digest) throw new HttpError(403, "每週摘要需要專業版 Weekly digest needs Pro");
    settings.tasks = { ...(settings.tasks ?? {}), digest: b.tasks.digest === true };
  }
  return patch;
}

// ---------- platform admin ----------

async function adminRoute(req: Request, path: string, body: <T>() => Promise<T>, deps: ApiDeps, secret: string): Promise<Response> {
  if (req.method === "GET" && path === "/api/admin/groups") {
    const all = await deps.groups.listAll();
    return json(
      await Promise.all(
        all.map(async (g) => ({
          groupId: g.groupId,
          name: g.name,
          status: g.status,
          channelId: g.channelId,
          planId: g.plan ?? "free",
          planUntil: g.planUntil,
          effectivePlan: effectivePlan(g.plan, g.planUntil).id,
          engine: g.settings?.translate?.engine ?? "google",
          monthlyChars: typeof g.settings?.translate?.monthlyChars === "number" ? g.settings.translate.monthlyChars : null,
          translateChars: await deps.usage.get(g.groupId, USAGE_METRIC),
          limit: monthlyLimit(g.settings?.translate ?? {}, effectivePlan(g.plan, g.planUntil)),
        })),
      ),
    );
  }

  let m = path.match(/^\/api\/admin\/groups\/([^/]+)$/);
  if (m && req.method === "PUT") {
    const group = await deps.groups.get(m[1]!);
    if (!group) throw new HttpError(404, "找不到群組 Group not found");
    const b = await body<{ plan?: unknown; planUntil?: unknown; status?: unknown; engine?: unknown; monthlyChars?: unknown }>();
    const patch: Parameters<GroupRepo["update"]>[1] = {};
    if (b.plan !== undefined) {
      if (!(typeof b.plan === "string" && b.plan in PLANS)) throw new HttpError(400, "未知的方案 Unknown plan");
      patch.plan = b.plan as PlanId;
    }
    if (b.planUntil !== undefined) {
      if (b.planUntil !== "" && !(typeof b.planUntil === "string" && /^\d{4}-\d{2}-\d{2}$/.test(b.planUntil))) throw new HttpError(400, "日期格式 YYYY-MM-DD");
      patch.planUntil = (b.planUntil as string) || "";
    }
    if (b.status !== undefined) {
      if (b.status !== "active" && b.status !== "pending") throw new HttpError(400, "status 只能是 active 或 pending");
      patch.status = b.status;
    }
    if (b.engine !== undefined || b.monthlyChars !== undefined) {
      const settings = structuredClone(group.settings ?? {});
      const t = (settings.translate ??= {});
      if (b.engine !== undefined) {
        if (b.engine !== "google" && b.engine !== "deepl" && b.engine !== "claude") throw new HttpError(400, "未知的翻譯引擎");
        t.engine = b.engine;
      }
      if (b.monthlyChars === null || b.monthlyChars === "") delete t.monthlyChars;
      else if (b.monthlyChars !== undefined) {
        const n = Number(b.monthlyChars);
        if (!Number.isInteger(n) || n < 0) throw new HttpError(400, "額度需為 0 以上的整數");
        t.monthlyChars = n;
      }
      patch.settings = settings;
    }
    return json(await deps.groups.update(group.groupId, patch));
  }

  if (req.method === "GET" && path === "/api/admin/channels") {
    const channels = await deps.channels.list();
    return json(
      channels.map((c) => ({
        channelId: c.channelId,
        name: c.name,
        joinPolicy: c.joinPolicy,
        webhookUrl: `${deps.origin}/webhook/${c.channelId}`,
      })),
    );
  }

  if (req.method === "POST" && path === "/api/admin/channels") {
    const b = await body<{ channelId?: unknown; name?: unknown; secret?: unknown; token?: unknown; joinPolicy?: unknown }>();
    const id = typeof b.channelId === "string" ? b.channelId.trim().toLowerCase() : "";
    if (!/^[a-z0-9-]{3,32}$/.test(id) || id === "default") throw new HttpError(400, "代號需為 3–32 個小寫英數或 -，且不能是 default");
    if (typeof b.name !== "string" || !b.name.trim()) throw new HttpError(400, "請填名稱");
    const existing = await deps.channels.get(id);
    const secretIn = typeof b.secret === "string" ? b.secret.trim() : "";
    const tokenIn = typeof b.token === "string" ? b.token.trim() : "";
    if (!existing && (!secretIn || !tokenIn)) throw new HttpError(400, "新頻道需要 Channel secret 與 access token");
    const joinPolicy = b.joinPolicy === "code" ? "code" : "open";
    await deps.channels.put({
      channelId: id,
      name: b.name.trim(),
      secretEnc: secretIn ? await encrypt(secret, secretIn) : existing!.secretEnc,
      tokenEnc: tokenIn ? await encrypt(secret, tokenIn) : existing!.tokenEnc,
      joinPolicy,
    });
    return json({ channelId: id, webhookUrl: `${deps.origin}/webhook/${id}` });
  }

  m = path.match(/^\/api\/admin\/channels\/([^/]+)$/);
  if (m && req.method === "DELETE") {
    await deps.channels.remove(m[1]!);
    return json({ ok: true });
  }

  if (req.method === "GET" && path === "/api/admin/codes") {
    const [codes, groups] = await Promise.all([deps.codes.list(), deps.groups.listAll()]);
    const names = new Map(groups.map((g) => [g.groupId, g.name]));
    const now = new Date().toISOString();
    return json(
      codes.map((c) => ({
        code: formatCode(c.code),
        label: c.label,
        channelId: c.channelId,
        plan: c.plan,
        planUntil: c.planUntil,
        expiresAt: c.expiresAt,
        createdAt: c.createdAt,
        status: c.usedAt ? "used" : c.expiresAt && c.expiresAt <= now ? "expired" : "unused",
        usedAt: c.usedAt,
        usedGroup: c.usedGroup && (names.get(c.usedGroup) ?? c.usedGroup),
      })),
    );
  }

  if (req.method === "POST" && path === "/api/admin/codes") {
    const b = await body<{ label?: unknown; channelId?: unknown; plan?: unknown; planUntil?: unknown; validDays?: unknown; count?: unknown }>();
    const channelId = typeof b.channelId === "string" && b.channelId ? b.channelId : "default";
    if (channelId !== "default" && !(await deps.channels.get(channelId))) throw new HttpError(400, "找不到這個頻道 Unknown channel");
    const plan = typeof b.plan === "string" && b.plan in PLANS ? b.plan : "free";
    const planUntil = typeof b.planUntil === "string" && b.planUntil ? b.planUntil : undefined;
    if (planUntil && !/^\d{4}-\d{2}-\d{2}$/.test(planUntil)) throw new HttpError(400, "方案到期日格式 YYYY-MM-DD");
    const days = b.validDays === undefined || b.validDays === "" ? 30 : Number(b.validDays);
    if (!Number.isInteger(days) || days < 0 || days > 365) throw new HttpError(400, "有效天數需為 0–365（0 = 不過期）");
    const count = b.count === undefined ? 1 : Number(b.count);
    if (!Number.isInteger(count) || count < 1 || count > 20) throw new HttpError(400, "一次最多產生 20 組");
    const expiresAt = days ? new Date(Date.now() + days * 86400 * 1000).toISOString() : undefined;
    const label = typeof b.label === "string" ? b.label.trim().slice(0, 100) : "";
    const created = [];
    for (let i = 0; i < count; i++) {
      created.push(await deps.codes.create({ label, channelId, plan, planUntil, expiresAt, createdBy: (await verifyMe(req, secret))?.sub }));
    }
    return json(created.map((c) => ({ code: formatCode(c.code), expiresAt: c.expiresAt, plan: c.plan, planUntil: c.planUntil })));
  }

  m = path.match(/^\/api\/admin\/codes\/([^/]+)$/);
  if (m && req.method === "DELETE") {
    if (!(await deps.codes.revoke(decodeURIComponent(m[1]!)))) throw new HttpError(400, "只能作廢還沒使用的啟用碼 Only unused codes can be revoked");
    return json({ ok: true });
  }

  throw new HttpError(404, "not found");
}

const verifyMe = (req: Request, secret: string) =>
  verifyToken<{ sub: string }>(secret, "session", req.headers.get("Authorization")?.replace(/^Bearer /, ""));

/** Verify a LIFF / LINE Login ID token against LINE's endpoint. */
export async function verifyLineIdToken(idToken: string, clientId: string | undefined, f: typeof fetch = (i, init) => fetch(i, init)) {
  if (!clientId) return undefined;
  const res = await f("https://api.line.me/oauth2/v2.1/verify", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ id_token: idToken, client_id: clientId }),
  });
  if (!res.ok) return undefined;
  const data = (await res.json()) as { sub?: string; name?: string };
  return data.sub ? { sub: data.sub, name: data.name } : undefined;
}
