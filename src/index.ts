import { handleApi, verifyLineIdToken, type ApiDeps } from "./api";
import appHtml from "./app/index.html";
import { decrypt } from "./core/crypto";
import { handleEvent, handleSchedule, type ChannelInfo, type Deps } from "./core/dispatcher";
import { LineClient, verifySignature, type LineApi } from "./core/line";
import type { Env, GroupConfig, LineEvent } from "./core/types";
import { plugins } from "./plugins";
import { handleReport } from "./report";
import { siteHtml } from "./site";
import { D1AdminRepo } from "./storage/admins";
import { D1ChannelRepo } from "./storage/channels";
import { D1CodeRepo } from "./storage/codes";
import { D1Storage } from "./storage/d1";
import { D1OutboxRepo } from "./storage/outbox";
import { D1GroupRepo, D1UsageMeter } from "./storage/groups";
import { MemoryStorage } from "./storage/memory";
import { SheetsStorage } from "./storage/sheets";
import type { Storage } from "./storage/types";

// Sheets storage instances live for the life of the Worker isolate (keeps Google tokens cached).
const storages = new Map<string, Storage>();

function storageFor(env: Env) {
  return (group: GroupConfig): Storage => {
    const kind = group.storage?.type ?? "d1";
    // D1 handles are bound to this request's env, so only cache the others.
    if (kind === "d1") return new D1Storage(env.DB, group.groupId);
    const key = `${group.groupId}|${kind}`;
    let s = storages.get(key);
    if (!s) {
      if (group.storage?.type === "sheets") {
        if (!env.GOOGLE_SERVICE_ACCOUNT_JSON) throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON not set");
        s = new SheetsStorage(group.storage.sheetId, env.GOOGLE_SERVICE_ACCOUNT_JSON);
      } else {
        s = new MemoryStorage();
      }
      storages.set(key, s);
    }
    return s;
  };
}

/** Credentials and join policy of a channel: "default" from the Worker's secrets, others from D1. */
async function loadChannel(env: Env, channelId: string): Promise<{ info: ChannelInfo; secret: string; token: string } | undefined> {
  if (channelId === "default") {
    return {
      info: { id: "default", joinPolicy: "code" },
      secret: env.LINE_CHANNEL_SECRET,
      token: env.LINE_CHANNEL_ACCESS_TOKEN,
    };
  }
  if (!env.APP_SECRET) return undefined;
  const c = await new D1ChannelRepo(env.DB).get(channelId);
  if (!c) return undefined;
  return {
    info: { id: c.channelId, joinPolicy: c.joinPolicy },
    secret: await decrypt(env.APP_SECRET, c.secretEnc),
    token: await decrypt(env.APP_SECRET, c.tokenEnc),
  };
}

function lineFor(env: Env) {
  return async (channelId: string): Promise<LineApi | undefined> => {
    const ch = await loadChannel(env, channelId);
    return ch && new LineClient(ch.token);
  };
}

async function webhook(req: Request, env: Env, ctx: ExecutionContext, channelId: string, origin: string): Promise<Response> {
  const ch = await loadChannel(env, channelId);
  if (!ch) return new Response("unknown channel", { status: 404 });

  const body = await req.text();
  if (!(await verifySignature(ch.secret, body, req.headers.get("x-line-signature")))) {
    return new Response("bad signature", { status: 401 });
  }

  const { events = [] } = JSON.parse(body) as { events?: LineEvent[] };
  const deps: Deps = {
    env,
    line: new LineClient(ch.token),
    channel: ch.info,
    groups: new D1GroupRepo(env.DB),
    admins: new D1AdminRepo(env.DB),
    codes: new D1CodeRepo(env.DB),
    usage: new D1UsageMeter(env.DB),
    plugins,
    storageFor: storageFor(env),
    origin,
    outbox: new D1OutboxRepo(env.DB),
  };
  // Answer LINE at once; do the work (translation, storage) in the background.
  ctx.waitUntil(Promise.all(events.map((e) => handleEvent(e, deps).catch((err) => console.error(err)))));
  return new Response("ok");
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    if (req.method === "GET" && path === "/health") return new Response("ok");
    if (req.method === "GET" && path === "/") {
      return new Response(siteHtml(url.origin), { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=300" } });
    }
    if (req.method === "GET" && (path === "/app" || path === "/app/")) {
      return new Response(appHtml, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
    }
    if (req.method === "GET" && path === "/api/config") {
      return Response.json({ liffId: env.LIFF_ID || null, devMode: env.DEV_MODE === "1" });
    }
    if (path.startsWith("/api/")) {
      const deps: ApiDeps = {
        env,
        groups: new D1GroupRepo(env.DB),
        admins: new D1AdminRepo(env.DB),
        channels: new D1ChannelRepo(env.DB),
        codes: new D1CodeRepo(env.DB),
        usage: new D1UsageMeter(env.DB),
        plugins,
        lineFor: lineFor(env),
        verifyIdToken: (t) => verifyLineIdToken(t, env.LOGIN_CHANNEL_ID),
        origin: url.origin,
        storageFor: storageFor(env),
      };
      return handleApi(req, deps);
    }

    const m = path.match(/^\/webhook(?:\/([a-z0-9-]{3,32}))?\/?$/);
    if (req.method === "POST" && m) return webhook(req, env, ctx, m[1] ?? "default", url.origin);

    if (req.method === "GET" && path.startsWith("/report/")) {
      const report = await handleReport(path, env.APP_SECRET, async (groupId) => {
        const group = await new D1GroupRepo(env.DB).get(groupId);
        return group && { group, storage: storageFor(env)(group) };
      });
      if (report) return report;
    }
    return new Response("not found", { status: 404 });
  },

  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const deps = { env, groups: new D1GroupRepo(env.DB), usage: new D1UsageMeter(env.DB), plugins, storageFor: storageFor(env), outbox: new D1OutboxRepo(env.DB) };
    ctx.waitUntil(handleSchedule(event.cron, deps, lineFor(env)));
  },
} satisfies ExportedHandler<Env>;
