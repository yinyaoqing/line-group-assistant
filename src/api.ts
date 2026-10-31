import { isLangCode, LANGUAGES } from "../config/languages";
import { DEFAULT_ENGINE, effectivePlan, ENGINE_CHOICES, planIdOf, PLANS, TOP_UP, UPGRADE_NOTE } from "../config/plans";
import { groupPlan, LINK_TTL_SECONDS } from "./core/dispatcher";
import { isTone, TONES } from "./plugins/translate/engines";
import { accountUsageKey, type Account, type AccountRepo } from "./storage/accounts";
import { encrypt, verifyToken, signToken } from "./core/crypto";
import type { LineApi } from "./core/line";
import type { Env, GroupConfig, Plugin } from "./core/types";
import { monthlyLimit, groupLanguages, USAGE_METRIC } from "./plugins/translate";
import { listMembers, setMemberLanguage } from "./plugins/translate/members";
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
 *   GET  /api/admin/accounts            platform admins: per-user accounts (Duo)
 *   PUT  /api/admin/accounts/:id        add top-up characters, change plan or end date
 */
export interface ApiDeps {
  env: Env;
  groups: GroupRepo;
  admins: AdminRepo;
  channels: ChannelRepo;
  codes: CodeRepo;
  /** Per-user subscriptions (Duo). */
  accounts?: AccountRepo;
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
const NOT_YOUR_LINK =
  "這個連結是給在群組輸入 /settings 的那位管理員的。請用他的 LINE 登入，或自己在群組輸入 /settings。\nThis link belongs to the admin who sent /settings; sign in as them, or send /settings yourself.";

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
        if (g?.accountId && deps.accounts) g.account = await deps.accounts.get(g.accountId);
        return g && { groupId: g.groupId, name: g.name, status: g.status, plan: groupPlan(g).id, role: a.role };
      }),
    );
    // Accounts belong to a LINE user ID; the person owns those matching an admin row they signed in through.
    const ownIds = new Set(mine.map((a) => a.lineUserId));
    const accounts = deps.accounts ? (await deps.accounts.list()).filter((a) => ownIds.has(a.userId)) : [];
    const accountViews = await Promise.all(accounts.map((a) => accountView(a, deps)));
    return json({ sub: me.sub, name: me.name, platformAdmin, groups: groups.filter(Boolean), accounts: accountViews });
  }

  let g = m(/^\/api\/groups\/([^/]+)$/);
  if (g && req.method === "GET") return json(await groupView(await allowedGroup(g[1]!, me.sub, platformAdmin, deps), deps));

  g = m(/^\/api\/groups\/([^/]+)\/settings$/);
  if (g && req.method === "PUT") {
    const group = await allowedGroup(g[1]!, me.sub, platformAdmin, deps);
    const b = await body<SettingsBody>();
    const updated = await deps.groups.update(group.groupId, applySettings(group, b, deps.plugins));
    if (b.members !== undefined) await applyMembers(updated!, b.members, deps);
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
    const link = await verifyToken<{ g: string; u: string; n: string; c?: string }>(secret, "link", b.link);
    if (!link) throw new HttpError(400, "連結已過期，請在群組重新輸入 /settings\nThe link has expired; send /settings again.");
    const admin = await deps.admins.get(link.g, link.u);
    if (!admin) throw new HttpError(403, "你已不是這個群組的管理員 You are no longer an admin of this group");

    // The link is posted in the group, so anyone there can tap it. Only the admin it
    // was issued to may bind: proved by the same user ID (chat and login in one
    // provider), by an earlier bind, or by typing a code back in the group.
    if (admin.loginSub) {
      if (admin.loginSub !== account.sub) throw new HttpError(403, NOT_YOUR_LINK);
      await deps.admins.consumeNonce(link.n); // a reload of an already-used link is fine
    } else if (account.sub === link.u) {
      if (!(await deps.admins.consumeNonce(link.n))) throw new HttpError(400, "連結已使用過，請重新輸入 /settings\nThis link was already used; send /settings again.");
      const res = await deps.admins.bindLogin(link.g, link.u, account.sub);
      if (res !== "ok") throw new HttpError(403, "這個管理員身分已綁定其他 LINE 帳號 This admin is linked to another LINE account");
    } else if ((link.c ?? "default") === "default") {
      // The default official account shares a provider with LINE Login, so the IDs would match.
      throw new HttpError(403, NOT_YOUR_LINK);
    } else {
      // A white-label account in another provider: IDs differ, so the admin confirms in the group.
      const code = await deps.admins.requestBind(link.g, link.u, account.sub, account.name ?? "", new Date(), LINK_TTL_SECONDS * 1000);
      return json({ confirm: { code, groupId: link.g }, sub: account.sub, name: account.name }, 202);
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
  if (group.accountId && deps.accounts) group.account = await deps.accounts.get(group.accountId);
  return group;
}

/** An account's plan, this month's use across its groups, and top-ups left. */
async function accountView(a: Account, deps: ApiDeps) {
  const plan = effectivePlan(a.plan, a.planUntil);
  return {
    accountId: a.accountId,
    plan: plan.name,
    planId: planIdOf(a.plan),
    planUntil: a.planUntil,
    used: await deps.usage.get(accountUsageKey(a.accountId), USAGE_METRIC),
    limit: plan.monthlyChars,
    bonusChars: a.bonusChars,
    topUp: plan.topUp ? TOP_UP : null,
  };
}

async function groupView(group: GroupConfig, deps: ApiDeps) {
  const plan = groupPlan(group);
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
    plan: { ...plan, until: plan.id === "free" ? undefined : (group.account?.planUntil ?? group.planUntil) },
    account: group.account ? await accountView(group.account, deps) : null,
    planId: group.plan ?? "free",
    plans: Object.values(PLANS),
    upgradeNote: UPGRADE_NOTE,
    plugins: group.plugins,
    availablePlugins: Object.keys(deps.plugins),
    translate: {
      languages: groupLanguages(t, plan),
      trigger: t.trigger ?? "all",
      targetMode: t.targetMode === "members" ? "members" : "all",
      showName: t.showName !== false,
      minLength: Number(t.minLength ?? 2),
      glossary: typeof t.glossary === "string" ? t.glossary : "",
      engine: t.engine ?? DEFAULT_ENGINE.engine,
      // The engine as one choice id: "google", or the Claude model.
      engineChoice: (t.engine ?? DEFAULT_ENGINE.engine) === "claude" ? String(t.model ?? DEFAULT_ENGINE.model) : String(t.engine),
      tone: isTone(t.tone) ? t.tone : "natural",
      toneNote: typeof t.toneNote === "string" ? t.toneNote : "",
      monthlyChars: typeof t.monthlyChars === "number" ? t.monthlyChars : null,
    },
    tasks: { digest: group.settings?.tasks?.digest === true },
    usage: group.account
      ? { translateChars: await deps.usage.get(accountUsageKey(group.account.accountId), USAGE_METRIC), limit: plan.monthlyChars }
      : { translateChars: await deps.usage.get(group.groupId, USAGE_METRIC), limit: monthlyLimit(t, plan) },
    engines: plan.engineChoice ? ENGINE_CHOICES.map((e) => ({ id: e.id, label: e.label })) : [],
    tones: Object.entries(TONES).map(([id, v]) => ({ id, label: v.label })),
    languages: Object.entries(LANGUAGES).map(([code, l]) => ({ code, name: l.name, flag: l.flag, allowed: plan.languages.includes(code as never) })),
    admins,
    // Members with a known language (they wrote, or an admin set them); LINE only lists a whole group for verified accounts.
    members: await Promise.all(
      (await listMembers(deps.storageFor(group), group.groupId)).map(async (m) => ({
        ...m,
        name: (line && (await line.groupMemberName(group.groupId, m.userId).catch(() => undefined))) ?? m.userId.slice(0, 8),
      })),
    ),
  };
}

/** Admins may set each known member's language from the settings page; like /lang, it then wins over detection. */
async function applyMembers(group: GroupConfig, members: unknown, deps: ApiDeps): Promise<void> {
  if (!Array.isArray(members)) throw new HttpError(400, "members 必須是陣列 members must be an array");
  const allowed = groupLanguages(group.settings?.translate ?? {}, groupPlan(group));
  const storage = deps.storageFor(group);
  for (const m of members as { userId?: unknown; lang?: unknown }[]) {
    if (typeof m.userId !== "string" || !m.userId || !isLangCode(m.lang) || !allowed.includes(m.lang)) {
      throw new HttpError(400, "未知的成員或語言 Unknown member or language");
    }
    await setMemberLanguage(storage, group.groupId, m.userId, m.lang, Date.now());
  }
}

interface SettingsBody {
  plugins?: unknown;
  translate?: {
    languages?: unknown;
    trigger?: unknown;
    targetMode?: unknown;
    showName?: unknown;
    minLength?: unknown;
    glossary?: unknown;
    engineChoice?: unknown;
    tone?: unknown;
    toneNote?: unknown;
  };
  tasks?: { digest?: unknown };
  /** [{ userId, lang }]: members' languages to set (see applyMembers). */
  members?: unknown;
}

/** What group admins may change. Engine and quota stay with platform admins. */
export function applySettings(group: GroupConfig, b: SettingsBody, plugins: Record<string, Plugin>) {
  const plan = groupPlan(group);
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
  if (bt?.targetMode !== undefined) {
    if (bt.targetMode !== "all" && bt.targetMode !== "members") throw new HttpError(400, "targetMode 只能是 all 或 members");
    t.targetMode = bt.targetMode;
  }
  if (bt?.showName !== undefined) t.showName = bt.showName === true;
  if (bt?.engineChoice !== undefined) {
    const choice = ENGINE_CHOICES.find((e) => e.id === bt.engineChoice);
    if (!choice) throw new HttpError(400, "未知的翻譯引擎 Unknown engine");
    if (!plan.engineChoice) throw new HttpError(403, "選擇翻譯引擎需要付費方案 Engine choice needs a paid plan");
    t.engine = choice.engine;
    if (choice.model) t.model = choice.model;
    else delete t.model;
  }
  if (bt?.tone !== undefined) {
    if (!isTone(bt.tone)) throw new HttpError(400, "未知的語氣 Unknown tone");
    t.tone = bt.tone;
  }
  if (bt?.toneNote !== undefined) {
    if (typeof bt.toneNote !== "string" || bt.toneNote.length > 200) throw new HttpError(400, "對話說明最多 200 字");
    t.toneNote = bt.toneNote.trim();
  }
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
    if (b.tasks.digest === true && !plan.digest) throw new HttpError(403, "每週摘要需要付費方案 Weekly digest needs a paid plan");
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
        all.map(async (g) => {
          if (g.accountId && deps.accounts) g.account = await deps.accounts.get(g.accountId);
          const plan = groupPlan(g);
          const key = g.account ? accountUsageKey(g.account.accountId) : g.groupId;
          return {
            groupId: g.groupId,
            name: g.name,
            status: g.status,
            channelId: g.channelId,
            accountId: g.accountId ?? "",
            effectivePlan: plan.id,
            planUntil: g.account?.planUntil ?? g.planUntil,
            engine: g.settings?.translate?.engine ?? DEFAULT_ENGINE.engine,
            translateChars: await deps.usage.get(key, USAGE_METRIC),
            limit: g.account ? plan.monthlyChars : monthlyLimit(g.settings?.translate ?? {}, plan),
          };
        }),
      ),
    );
  }

  let m = path.match(/^\/api\/admin\/groups\/([^/]+)$/);
  if (m && req.method === "PUT") {
    const group = await deps.groups.get(m[1]!);
    if (!group) throw new HttpError(404, "找不到群組 Group not found");
    const b = await body<{ accountId?: unknown; status?: unknown; engine?: unknown }>();
    const patch: Parameters<GroupRepo["update"]>[1] = {};
    // Plans live on accounts; here the group moves to another account (e.g. the foreman left) or is unbound.
    if (b.accountId !== undefined) {
      if (b.accountId === "") patch.accountId = "";
      else if (typeof b.accountId === "string" && deps.accounts && (await deps.accounts.get(b.accountId))) patch.accountId = b.accountId;
      else throw new HttpError(400, "找不到這個帳號 Unknown account");
    }
    if (b.status !== undefined) {
      if (b.status !== "active" && b.status !== "pending") throw new HttpError(400, "status 只能是 active 或 pending");
      patch.status = b.status;
    }
    if (b.engine !== undefined) {
      if (b.engine !== "google" && b.engine !== "deepl" && b.engine !== "claude") throw new HttpError(400, "未知的翻譯引擎");
      const settings = structuredClone(group.settings ?? {});
      (settings.translate ??= {}).engine = b.engine;
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
        webhookUrl: `${deps.origin}/webhook/${c.channelId}`,
      })),
    );
  }

  if (req.method === "POST" && path === "/api/admin/channels") {
    const b = await body<{ channelId?: unknown; name?: unknown; secret?: unknown; token?: unknown }>();
    const id = typeof b.channelId === "string" ? b.channelId.trim().toLowerCase() : "";
    if (!/^[a-z0-9-]{3,32}$/.test(id) || id === "default") throw new HttpError(400, "代號需為 3–32 個小寫英數或 -，且不能是 default");
    if (typeof b.name !== "string" || !b.name.trim()) throw new HttpError(400, "請填名稱");
    const existing = await deps.channels.get(id);
    const secretIn = typeof b.secret === "string" ? b.secret.trim() : "";
    const tokenIn = typeof b.token === "string" ? b.token.trim() : "";
    if (!existing && (!secretIn || !tokenIn)) throw new HttpError(400, "新頻道需要 Channel secret 與 access token");
    await deps.channels.put({
      channelId: id,
      name: b.name.trim(),
      secretEnc: secretIn ? await encrypt(secret, secretIn) : existing!.secretEnc,
      tokenEnc: tokenIn ? await encrypt(secret, tokenIn) : existing!.tokenEnc,
    });
    return json({ channelId: id, webhookUrl: `${deps.origin}/webhook/${id}` });
  }

  m = path.match(/^\/api\/admin\/channels\/([^/]+)$/);
  if (m && req.method === "DELETE") {
    await deps.channels.remove(m[1]!);
    return json({ ok: true });
  }

  if (req.method === "GET" && path === "/api/admin/accounts") {
    const accounts = deps.accounts ? await deps.accounts.list() : [];
    return json(await Promise.all(accounts.map((a) => accountView(a, deps))));
  }

  m = path.match(/^\/api\/admin\/accounts\/([^/]+)$/);
  if (m && req.method === "PUT") {
    if (!deps.accounts) throw new HttpError(503, "帳號功能未開通");
    const id = decodeURIComponent(m[1]!);
    if (!(await deps.accounts.get(id))) throw new HttpError(404, "找不到帳號 Account not found");
    const b = await body<{ bonusAdd?: unknown; plan?: unknown; planUntil?: unknown }>();
    if (b.bonusAdd !== undefined && b.bonusAdd !== "") {
      const n = Number(b.bonusAdd);
      if (!Number.isInteger(n) || Math.abs(n) > 10_000_000) throw new HttpError(400, "加值字數需為整數（可為負數扣回）");
      await deps.accounts.addBonus(id, n);
    }
    if (b.plan !== undefined) {
      if (!(typeof b.plan === "string" && b.plan in PLANS)) throw new HttpError(400, "未知的方案 Unknown plan");
      await deps.accounts.update(id, { plan: b.plan });
    }
    if (b.planUntil !== undefined) {
      if (b.planUntil !== "" && !(typeof b.planUntil === "string" && /^\d{4}-\d{2}-\d{2}$/.test(b.planUntil))) throw new HttpError(400, "日期格式 YYYY-MM-DD");
      await deps.accounts.update(id, { planUntil: b.planUntil as string });
    }
    return json(await accountView((await deps.accounts.get(id))!, deps));
  }

  if (req.method === "GET" && path === "/api/admin/codes") {
    const [codes, groups] = await Promise.all([deps.codes.list(), deps.groups.listAll()]);
    const names = new Map(groups.map((g) => [g.groupId, g.name]));
    const now = new Date().toISOString();
    return json(
      codes.map((c) => ({
        code: formatCode(c.code),
        kind: c.kind ?? "activate",
        chars: c.chars ?? 0,
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
    const b = await body<{ label?: unknown; channelId?: unknown; plan?: unknown; planUntil?: unknown; validDays?: unknown; count?: unknown; kind?: unknown; chars?: unknown }>();
    const kind = b.kind === "topup" ? "topup" : "activate";
    const chars = kind === "topup" ? (b.chars === undefined || b.chars === "" ? TOP_UP.chars : Number(b.chars)) : 0;
    if (kind === "topup" && (!Number.isInteger(chars) || chars < 1 || chars > 10_000_000)) throw new HttpError(400, "加購字數需為 1 到 10,000,000 的整數");
    const channelId = typeof b.channelId === "string" && b.channelId ? b.channelId : "default";
    if (channelId !== "default" && !(await deps.channels.get(channelId))) throw new HttpError(400, "找不到這個頻道 Unknown channel");
    const plan = typeof b.plan === "string" && b.plan in PLANS ? b.plan : "free";
    const planUntil = typeof b.planUntil === "string" && b.planUntil ? b.planUntil : undefined;
    if (planUntil && !/^\d{4}-\d{2}-\d{2}$/.test(planUntil)) throw new HttpError(400, "方案到期日格式 YYYY-MM-DD");
    if (kind === "activate" && plan !== "free" && !planUntil) throw new HttpError(400, "付費方案的啟用碼需要到期日 A paid plan needs an end date");
    const days = b.validDays === undefined || b.validDays === "" ? 30 : Number(b.validDays);
    if (!Number.isInteger(days) || days < 0 || days > 365) throw new HttpError(400, "有效天數需為 0–365（0 = 不過期）");
    const count = b.count === undefined ? 1 : Number(b.count);
    if (!Number.isInteger(count) || count < 1 || count > 20) throw new HttpError(400, "一次最多產生 20 組");
    const expiresAt = days ? new Date(Date.now() + days * 86400 * 1000).toISOString() : undefined;
    const label = typeof b.label === "string" ? b.label.trim().slice(0, 100) : "";
    const created = [];
    for (let i = 0; i < count; i++) {
      created.push(await deps.codes.create({ label, channelId, plan, planUntil, expiresAt, createdBy: (await verifyMe(req, secret))?.sub, kind, chars }));
    }
    return json(created.map((c) => ({ code: formatCode(c.code), expiresAt: c.expiresAt, plan: c.plan, planUntil: c.planUntil, kind: c.kind, chars: c.chars })));
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
  if (!res.ok) {
    // e.g. 400 {"error":"invalid_request","error_description":"IdToken expired."}; visible in `wrangler tail`.
    console.error("LINE ID token rejected", res.status, await res.text().catch(() => ""));
    return undefined;
  }
  const data = (await res.json()) as { sub?: string; name?: string };
  return data.sub ? { sub: data.sub, name: data.name } : undefined;
}
