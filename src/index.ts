import { groups } from "../config/groups";
import { handleEvent, handleSchedule, type Deps } from "./core/dispatcher";
import { LineClient, verifySignature } from "./core/line";
import type { Env, GroupConfig, LineEvent } from "./core/types";
import { plugins } from "./plugins";
import { MemoryStorage } from "./storage/memory";
import { SheetsStorage } from "./storage/sheets";
import type { Storage } from "./storage/types";

// Storage instances live for the life of the Worker isolate (keeps Sheets tokens cached).
const storages = new Map<string, Storage>();

function deps(env: Env): Deps {
  return {
    env,
    line: new LineClient(env.LINE_CHANNEL_ACCESS_TOKEN),
    groups,
    plugins,
    storageFor(group: GroupConfig): Storage {
      let s = storages.get(group.groupId);
      if (!s) {
        if (group.storage?.type === "sheets") {
          if (!env.GOOGLE_SERVICE_ACCOUNT_JSON) throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON not set");
          s = new SheetsStorage(group.storage.sheetId, env.GOOGLE_SERVICE_ACCOUNT_JSON);
        } else {
          s = new MemoryStorage();
        }
        storages.set(group.groupId, s);
      }
      return s;
    },
  };
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === "GET" && url.pathname === "/") return new Response("ok");
    if (req.method !== "POST" || url.pathname !== "/webhook") return new Response("not found", { status: 404 });

    const body = await req.text();
    if (!(await verifySignature(env.LINE_CHANNEL_SECRET, body, req.headers.get("x-line-signature")))) {
      return new Response("bad signature", { status: 401 });
    }

    const { events = [] } = JSON.parse(body) as { events?: LineEvent[] };
    const d = deps(env);
    // Answer LINE at once; do the work (translation, Sheets) in the background.
    ctx.waitUntil(Promise.all(events.map((e) => handleEvent(e, d).catch((err) => console.error(err)))));
    return new Response("ok");
  },

  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(handleSchedule(event.cron, deps(env)));
  },
} satisfies ExportedHandler<Env>;
