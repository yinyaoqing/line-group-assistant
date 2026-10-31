import { defaultGroup } from "../../config/defaults";
import { effectivePlan, PLAN_RANK, TOP_UP } from "../../config/plans";
import { monthlyLimit, USAGE_METRIC } from "../plugins/translate";
import { accountIdOf, accountUsageKey, type AccountRepo } from "../storage/accounts";
import type { AdminRepo } from "../storage/admins";
import type { ActivationCode, CodeRepo } from "../storage/codes";
import type { GroupRepo, UsageMeter } from "../storage/groups";
import type { OutboxRepo } from "../storage/outbox";
import type { Storage } from "../storage/types";
import { buildReport, reportUrl, summaryText } from "../report";
import { AI_METRIC, gatherContext, interpret, isReadOnly, stripSelfMention } from "./assistant";
import { randomId, signToken } from "./crypto";
import type { LineApi } from "./line";
import type { Env, GroupConfig, LineEvent, LineMessage, Plugin, PluginContext } from "./types";
import { action, tag, tagOf, text, withQuickReply, type QuickItem, type Template } from "./types";

/** The LINE official account an event came in on, and how its groups get activated. */
export interface ChannelInfo {
  id: string;
}

export interface Deps {
  env: Env;
  /** Client for the channel this event came in on. */
  line: LineApi;
  channel: ChannelInfo;
  groups: GroupRepo;
  admins: AdminRepo;
  codes: CodeRepo;
  usage: UsageMeter;
  plugins: Record<string, Plugin>;
  storageFor(group: GroupConfig): Storage;
  /** This Worker's public origin, for links the bot sends (reports). */
  origin: string;
  /** Where scheduled sends wait for the next free reply; without it they are pushed. */
  outbox?: OutboxRepo;
  /** Per-user subscriptions (Duo); without it, groups are only billed on their own. */
  accounts?: AccountRepo;
}

/** LINE accepts at most this many messages per reply. */
const MAX_REPLY_MESSAGES = 5;

/** How long a /settings link stays valid. */
export const LINK_TTL_SECONDS = 10 * 60;

const groupIdOf = (e: LineEvent) => e.source.groupId ?? e.source.roomId;

/**
 * The plan in force for a group: its account's. Groups from before accounts
 * (not yet bound to one) fall back to their own legacy plan.
 */
export const groupPlan = (group: GroupConfig) =>
  group.account ? effectivePlan(group.account.plan, group.account.planUntil) : effectivePlan(group.plan, group.planUntil);

function context(deps: Pick<Deps, "env" | "usage" | "storageFor" | "outbox" | "accounts"> & { admins?: AdminRepo }, line: LineApi, group: GroupConfig, plugin: Plugin): PluginContext {
  const names = new Map<string, string | undefined>();
  // Usage of a group bound to an account is metered on the account, across all its groups.
  const account = group.account;
  const meterKey = account ? accountUsageKey(account.accountId) : group.groupId;
  return {
    env: deps.env,
    group,
    storage: deps.storageFor(group),
    settings: group.settings?.[plugin.name] ?? {},
    plan: groupPlan(group),
    bonus:
      account && deps.accounts
        ? {
            get: async () => (await deps.accounts!.get(account.accountId))?.bonusChars ?? 0,
            consume: async (chars) => void (await deps.accounts!.addBonus(account.accountId, -chars)),
          }
        : undefined,
    async displayName(userId) {
      if (!userId) return undefined;
      if (!names.has(userId)) {
        try {
          names.set(userId, await line.groupMemberName(group.groupId, userId));
        } catch {
          names.set(userId, undefined);
        }
      }
      return names.get(userId);
    },
    push: (messages) =>
      // Scheduled sends always wait for the next free reply; the official account's push quota is shared by every group.
      deps.outbox ? deps.outbox.add(group.groupId, messages) : line.push(group.groupId, messages),
    usage: {
      get: (metric) => deps.usage.get(meterKey, metric),
      add: (metric, amount) => deps.usage.add(meterKey, metric, amount),
    },
    isAdmin: async (userId) => !!(userId && deps.admins && (await deps.admins.get(group.groupId, userId))),
  };
}

/**
 * Parse "/cmd a b c" into its parts; null if not a command. Accepts the
 * full-width "／" that Chinese phone keyboards type, and ignores the case of
 * the command name (phones like to capitalise "/Task").
 */
export function parseCommand(input: string): { name: string; args: string[]; rest: string } | null {
  const m = input.trim().match(/^[/／](\S+)\s*([\s\S]*)$/);
  if (!m) return null;
  const rest = (m[2] ?? "").trim();
  return { name: m[1]!.toLowerCase(), args: rest ? rest.split(/\s+/) : [], rest };
}

const HELP: QuickItem = { label: "❓ 說明 Help", text: "/help" };
const TEMPLATES: QuickItem = { label: "📝 範本 Templates", text: "/template" };
const MENU: QuickItem = { label: "📱 選單 Menu", text: "/menu" };

/**
 * /menu: every feature as a big button. Unlike quick replies, which LINE shows
 * only on phones, card buttons also work in LINE for PC and Mac.
 */
/** Forms per plugin, opened in LINE (LIFF); each sends the matching command as the member. */
const FORMS: { plugin: string; label: string; form: string }[] = [
  { plugin: "tasks", label: "➕ 新增任務 New task", form: "task" },
  { plugin: "tasks", label: "✅ 完成回報 Report done", form: "done" },
  { plugin: "tools", label: "🔧 工具增減 Tools", form: "tool" },
  { plugin: "materials", label: "🧱 材料增減 Materials", form: "material" },
];

/**
 * /form: buttons that open fill-in forms in LINE. URI buttons work on LINE for
 * PC too; the form must be opened from the group so it can send into it.
 */
export function formCard(active: Plugin[], liffId: string | undefined): LineMessage {
  const names = new Set(active.map((p) => p.name));
  const forms = FORMS.filter((f) => names.has(f.plugin));
  if (!liffId || !forms.length) return text("⚠️ 表單尚未開通 Forms are not set up yet.");
  return {
    type: "template",
    altText: "📝 表單 Forms",
    template: {
      type: "buttons",
      text: "📝 用表單填寫，送出後會用你的名義在群組發出指令\nFill in a form; it is sent to the group as you.",
      actions: forms.slice(0, 4).map((f) => ({ type: "uri", label: f.label.slice(0, 20), uri: `https://liff.line.me/${liffId}?form=${f.form}` })),
    },
  };
}

const FORM: QuickItem = { label: "📝 表單 Forms", text: "/form" };

export function menuCard(active: Plugin[]): LineMessage {
  const items: QuickItem[] = [
    ...active.flatMap((p) => p.quickReplies ?? []),
    FORM,
    { label: "📊 報表 Report", text: "/report" },
    TEMPLATES,
    { label: "⚙️ 設定 Settings", text: "/settings" },
    HELP,
  ];
  const button = (i: QuickItem) => ({
    type: "button",
    style: "secondary",
    height: "sm",
    flex: 1,
    action: action(i),
  });
  const rows = [];
  for (let i = 0; i < items.length; i += 2) {
    rows.push({ type: "box", layout: "horizontal", spacing: "sm", contents: items.slice(i, i + 2).map(button) });
  }
  return {
    type: "flex",
    altText: `📱 選單 Menu\n${items.map((i) => `${i.label}：${i.text}`).join("\n")}`.slice(0, 400),
    contents: {
      type: "bubble",
      body: {
        type: "box",
        layout: "vertical",
        spacing: "sm",
        contents: [
          { type: "text", text: "📱 功能選單 Menu", weight: "bold" },
          { type: "text", text: "點按鈕即可操作。電腦版 LINE 看不到下方快速按鈕時，輸入 /menu 叫出這張卡片。", size: "xs", color: "#888888", wrap: true },
          ...rows,
        ],
      },
    },
  };
}

/** /help: how to get around first, then one section per active plugin, then the core commands. */
export function helpText(active: Plugin[]): string {
  const sections = active.filter((p) => p.help).map((p) => [p.help!.title, ...p.help!.lines.map((l) => `・${l}`)].join("\n"));
  return [
    "📖 使用說明 How to use",
    "👆 最快：點輸入框上方的按鈕；按鈕不見時輸入 /m 叫出來（電腦版 LINE 沒有這排按鈕，請輸入 /menu）\n📝 要打字：輸入 /template 拿範本，按「複製」→ 貼到輸入框 → 改內容 → 送出",
    ...sections,
    "📝 /form　用表單填寫，不用打指令\n🤖 @我 加上你想做的事，用說的就好，任何語言都可以（專業版）\n📊 /report　匯出報表（Excel／PDF）\n⚙️ /settings　設定頁（管理員）\n👥 /admin　管理員名單",
  ].join("\n\n");
}

/**
 * /template [feature]: the active plugins' templates as a card with a Copy button
 * each. "/template item" narrows it to one plugin (by name or command).
 */
export function templateCard(active: Plugin[], filter?: string): { card: LineMessage; templates: Template[] } | undefined {
  const f = filter?.toLowerCase();
  const chosen = active.filter((p) => !f || p.name === f || p.name === `${f}s` || p.commands?.includes(f));
  const templates = chosen.flatMap((p) => p.templates ?? []);
  if (!templates.length) return undefined;
  const rows = templates.map((t) => ({
    type: "box",
    layout: "vertical",
    spacing: "xs",
    contents: [
      { type: "text", text: t.label, size: "xs", color: "#888888" },
      {
        type: "box",
        layout: "horizontal",
        spacing: "sm",
        alignItems: "center",
        contents: [
          { type: "text", text: t.text, size: "sm", weight: "bold", wrap: true, flex: 5 },
          { type: "button", style: "secondary", height: "sm", flex: 2, action: { type: "clipboard", label: "📋 複製", clipboardText: t.text } },
        ],
      },
      ...(t.note ? [{ type: "text", text: t.note, size: "xxs", color: "#888888", wrap: true }] : []),
    ],
  }));
  return {
    templates,
    card: {
      type: "flex",
      altText: `📝 範本 Templates\n${templates.map((t) => t.text).join("\n")}`.slice(0, 400),
      contents: {
        type: "bubble",
        body: {
          type: "box",
          layout: "vertical",
          spacing: "lg",
          contents: [
            { type: "text", text: "📝 指令範本 Templates", weight: "bold" },
            { type: "text", text: "按「複製」→ 貼到輸入框 → 把中文改成實際內容 → 送出", size: "xs", color: "#888888", wrap: true },
            ...rows,
          ],
        },
      },
    },
  };
}

/** Route one webhook event to the group's plugins and send a single merged reply. */
export async function handleEvent(event: LineEvent, deps: Deps): Promise<void> {
  const gid = groupIdOf(event);
  if (!gid) return; // 1:1 chats are not handled
  const userId = event.source.userId;
  // A button tap (postback) carries the command it stands for; nothing was posted to the chat.
  const viaButton = event.type === "postback";
  const input = viaButton ? event.postback?.data : event.message?.type === "text" ? event.message.text : undefined;

  const send = async (messages: LineMessage[]) => {
    if (event.replyToken && messages.length) await deps.line.reply(event.replyToken, messages);
  };
  const reply = (msg: string) => send([text(msg)]);

  if (event.type === "leave") {
    await deps.groups.update(gid, { status: "left" });
    return;
  }

  // Bot just joined: register the group as pending; it waits for /activate <code> on every channel.
  if (event.type === "join") {
    const name = await deps.line.groupName(gid).catch(() => undefined);
    await deps.groups.register({ ...defaultGroup(gid, deps.channel.id), name });
  }

  const group = await deps.groups.get(gid);
  const pre = input ? parseCommand(input) : null;

  if (event.type === "join" || pre?.name === "id") {
    if (group?.status !== "active") {
      return reply(
        `👋 群組 ID / Group ID:\n${gid}\n\n請管理員輸入 /activate <啟用碼> 開始使用。\nAsk the admin to send /activate <code> to turn the bot on.`,
      );
    }
    const claim = (await deps.admins.list(gid)).length ? "" : "\n\n第一位輸入 /activate 的成員會成為管理員。\nThe first member to send /activate becomes the admin.";
    return reply(`✅ 已啟用 Active：${group.name ?? gid}\n功能 Plugins: ${group.plugins.join(", ")}\n輸入 /help 查看指令${claim}`);
  }

  if (pre?.name === "activate") return activate(gid, group, pre.args[0], userId, deps, reply);

  if (group?.status !== "active") return;
  if (group.accountId && deps.accounts) group.account = await deps.accounts.get(group.accountId);
  const active = group.plugins.map((n) => deps.plugins[n]).filter((p): p is Plugin => !!p);
  const quick = [...active.flatMap((p) => p.quickReplies ?? []), FORM, MENU, TEMPLATES, HELP];

  /**
   * Reply with the quick reply buttons on the last message (shown on phones only).
   * After a button tap, say who tapped, since nothing appeared in the chat.
   * Messages queued for this group (e.g. the weekly digest) ride along first,
   * even when the event itself needs no reply, since replies are free and
   * pushes are not. Then hand plugins the LINE IDs of the messages they
   * tagged, so quotes map back.
   */
  const sendQ = async (messages: LineMessage[]) => {
    if (!event.replyToken) return;
    const own = [...messages];
    const first = own[0] as { type?: string; text?: string } | undefined;
    if (viaButton && userId && first?.type === "text") {
      const who = await deps.line.groupMemberName(group.groupId, userId).catch(() => undefined);
      if (who) {
        const t = tagOf(own[0]!);
        own[0] = { ...own[0], text: `👆 ${who}\n${first.text}` };
        if (t) tag(own[0], t.plugin, t.key);
      }
    }
    const queued = deps.outbox ? await deps.outbox.take(group.groupId, MAX_REPLY_MESSAGES - own.length).catch(() => []) : [];
    const all = [...queued, ...own];
    if (!all.length) return;
    const out = all.map((m, i) => (i === all.length - 1 ? withQuickReply(m, quick) : m));
    const ids = await deps.line.reply(event.replyToken, out);
    if (!ids) return;
    for (const [i, m] of out.entries()) {
      const t = tagOf(m);
      const plugin = t && deps.plugins[t.plugin];
      if (!t || !ids[i] || !plugin?.onSent) continue;
      await plugin.onSent(t.key, ids[i]!, context(deps, deps.line, group, plugin)).catch((err) => console.error(`onSent ${plugin.name} failed`, err));
    }
  };

  if (event.type === "memberJoined") {
    const joined = (event.joined?.members ?? []).map((m) => m.userId).filter((u): u is string => !!u);
    const replies: LineMessage[] = [];
    for (const plugin of active) {
      if (!plugin.onMemberJoined || !joined.length) continue;
      const out = await plugin.onMemberJoined(joined, context(deps, deps.line, group, plugin)).catch((err) => console.error(err));
      if (out) replies.push(...out);
    }
    return sendQ(replies.slice(0, 5));
  }

  // Stickers, photos, non-command taps: nothing to answer, but queued messages can still go out.
  if (!input) return sendQ([]);
  if (viaButton && !pre) return sendQ([]); // buttons only ever stand for commands
  // The Confirm button is single-use: it names the pending request, not the command, so a second tap does nothing.
  if (pre?.name === "ok") return sendQ(await runPending(group, pre.args[0], userId, event, deps));
  // Any other button tap settles whatever the assistant was waiting on for this member.
  if (viaButton && userId) await takePending(deps.storageFor(group), userId, event.timestamp).catch(() => undefined);

  const mentionees = event.message?.mention?.mentionees ?? [];
  const request = stripSelfMention(input, mentionees);

  // "要" / "是" / "不用" after the assistant asked: the answer applies to the command it is holding.
  if (!pre && !viaButton && userId && (YES.test(request) || NO.test(request))) {
    const pending = await takePending(deps.storageFor(group), userId, event.timestamp);
    if (pending) {
      if (NO.test(request)) return sendQ([text("👌 好，取消了。Cancelled.")]);
      return handleEvent({ ...event, message: { type: "text", id: event.message!.id, text: pending } }, deps);
    }
  }

  // "@bot …" in plain words: the AI assistant turns it into a command.
  if (!pre && mentionees.some((m) => m.isSelf)) {
    const reply = await assistantReply(request, group, active, userId, deps, event.timestamp);
    if (reply.run) return handleEvent({ ...event, message: { type: "text", id: event.message!.id, text: reply.run } }, deps);
    return sendQ(reply.messages);
  }

  const raw = input;
  const cmd = pre;
  const replies: LineMessage[] = [];

  if (pre?.name === "settings") return sendQ(await settingsLink(group, userId, deps));
  if (pre?.name === "admin") return sendQ([text(await adminCommand(group, pre.args, userId, event, deps))]);
  if (pre?.name === "report") return sendQ(await reportReply(group, deps));
  if (pre?.name === "menu") return sendQ([menuCard(active)]);
  if (pre?.name === "usage") return sendQ([text(await usageText(group, deps))]);
  if (pre?.name === "topup") return sendQ([text(await topUp(group, pre.args[0], userId, deps))]);
  if (pre?.name === "confirm") return sendQ([text(await confirmBind(group, pre.args[0], userId, deps))]);
  if (pre?.name === "form") return sendQ([formCard(active, deps.env.LIFF_ID)]);
  // /m: the smallest reply that can carry the quick reply buttons, for phones.
  if (pre?.name === "m") return sendQ([text("👇")]);

  if (cmd?.name === "template") {
    const t = templateCard(active, cmd.args[0]);
    if (!t) return sendQ([text("這個功能沒有範本。輸入 /template 看全部。")]);
    try {
      return await sendQ([t.card]);
    } catch (err) {
      // Older LINE versions reject the clipboard action: send each template as its own
      // message instead, which can be long-pressed and copied.
      console.error("template card failed, sending plain text", err);
      return sendQ([text("長按下面的訊息 → 複製 → 貼上修改後送出"), ...t.templates.slice(0, 4).map((x) => text(x.text))]);
    }
  }

  for (const plugin of active) {
    const ctx = context(deps, deps.line, group, plugin);
    try {
      let out: LineMessage[] | void = undefined;
      if (cmd) {
        if (plugin.onCommand && plugin.commands?.includes(cmd.name)) {
          out = await plugin.onCommand({ ...cmd, text: raw, userId, event }, ctx);
        }
      } else if (plugin.onMessage) {
        out = await plugin.onMessage({ text: raw, userId, event }, ctx);
      }
      if (out) replies.push(...out);
    } catch (err) {
      console.error(`plugin ${plugin.name} failed`, err);
    }
  }

  if (cmd && cmd.name === "help") replies.push(text(helpText(active)));

  // The quick reply buttons ride on every reply. LINE hides them once anyone posts
  // and groups have no rich menu, so replying with them each time (translations
  // included) is as close to always-on as a group allows.
  const out = replies.slice(0, 5);
  await sendQ(out);
}

/**
 * What to do with "@bot <request>": run a read-only command straight away, ask
 * for a tap to confirm anything that changes data, or answer in words.
 */
async function assistantReply(
  request: string,
  group: GroupConfig,
  active: Plugin[],
  userId: string | undefined,
  deps: Deps,
  now: number,
): Promise<{ run?: string; messages: LineMessage[] }> {
  const say = (msg: string) => ({ messages: [text(msg)] });
  if (!groupPlan(group).ai) {
    return say("🤖 用說的操作（AI 助理）是付費方案功能。\nAI requests need a paid plan. 輸入 /menu 用按鈕操作。");
  }
  if (!deps.env.ANTHROPIC_API_KEY) return say("⚠️ AI 助理尚未開通（缺少 ANTHROPIC_API_KEY）。");
  const cap = groupPlan(group).aiRequests;
  if (cap && (await context(deps, deps.line, group, { name: "assistant" }).usage.get(AI_METRIC)) >= cap) {
    return say(`🤖 本月 AI 助理 ${cap} 次已用完，下個月 1 日恢復；可以先用 /menu 按鈕操作。\nThis month's ${cap} assistant requests are used up.`);
  }
  if (!request) return say("🤖 有什麼需要幫忙？例如：「@我 新增任務 明天買螺絲 給阿明」\nHow can I help? e.g. \"@me add a task: buy screws tomorrow\"");

  const ctx = context(deps, deps.line, group, { name: "assistant" });
  try {
    const [data, speaker] = await Promise.all([gatherContext(ctx), ctx.displayName(userId).then((n) => n ?? "member")]);
    const today = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
    const decision = await interpret(deps.env, { request, speaker, plugins: active, today, ...data });
    await ctx.usage.add(AI_METRIC, 1);
    if (decision.kind === "answer") return say(`🤖 ${decision.reply}`);
    if (isReadOnly(decision.command)) return { run: decision.command, messages: [] };
    // Anything that changes data waits for a tap, or a "要"/"yes" within CONFIRM_WINDOW_MS,
    // so a misread request is never applied silently.
    const nonce = userId ? await rememberPending(deps.storageFor(group), userId, decision.command, now) : "";
    return {
      messages: [
        {
          type: "template",
          altText: `🤖 ${decision.reply}`.slice(0, 400),
          template: {
            type: "buttons",
            text: `🤖 ${decision.reply}\n${decision.command}`.slice(0, 160),
            actions: [action({ label: "✓ 執行 Confirm", text: nonce ? `/ok ${nonce}` : decision.command })],
          },
        },
      ],
    };
  } catch (err) {
    console.error("assistant failed", err);
    return say("⚠️ AI 助理暫時無法使用，請改用 /menu 或指令。\nThe assistant is unavailable right now.");
  }
}

/**
 * Where a "@bot …" request waits for its yes: the group's "assistant" table,
 * one row per member, holding the command and when the offer expires. The
 * Confirm button still works; this lets a typed 要／是／ok (or 不用 to drop it)
 * do the same, since that is what people answer a question with.
 */
const CONFIRM_TABLE = "assistant";
export const CONFIRM_WINDOW_MS = 10 * 60 * 1000;
const YES = /^(要|是|是的|好|好的|好啊|對|可以|確認|執行|沒錯|ok|okay|yes|y|đúng|vâng|ừ|ya|iya|ใช่|oo|opo|はい)[!！。.~～]*$/i;
const NO = /^(不要|不用|不是|不對|取消|算了|no|n|nope|không|tidak|ไม่|hindi|いいえ)[!！。.~～]*$/i;

/** Park the command and return the nonce the Confirm button carries. */
async function rememberPending(storage: Storage, userId: string, command: string, now: number): Promise<string> {
  const row = (await storage.list(CONFIRM_TABLE)).find((r) => r.userId === userId);
  const nonce = randomId(6);
  const fields = { command, nonce, until: new Date(now + CONFIRM_WINDOW_MS).toISOString() };
  if (row) await storage.update(CONFIRM_TABLE, row.id, fields);
  else await storage.append(CONFIRM_TABLE, { userId, ...fields });
  return nonce;
}

/** The member's pending command if it has not expired; either way it is cleared, so an answer counts once. */
async function takePending(storage: Storage, userId: string, now: number): Promise<string | undefined> {
  const row = (await storage.list(CONFIRM_TABLE)).find((r) => r.userId === userId);
  if (!row?.command) return undefined;
  await storage.update(CONFIRM_TABLE, row.id, { command: "", nonce: "", until: "" });
  return new Date(row.until ?? 0).getTime() >= now ? row.command : undefined;
}

/**
 * "/ok <nonce>" from the Confirm button: run the request it stands for, once,
 * and only for the member who made it (the row is theirs).
 */
async function runPending(group: GroupConfig, nonce: string | undefined, userId: string | undefined, event: LineEvent, deps: Deps): Promise<LineMessage[]> {
  const storage = deps.storageFor(group);
  const row = nonce ? (await storage.list(CONFIRM_TABLE)).find((r) => r.nonce === nonce && r.command) : undefined;
  if (!row) return [text("ℹ️ 這個確認已經執行過或過期了。Already done, or expired.")];
  if (!row.userId || row.userId !== userId) return [text("🔒 請由提出要求的人按確認。Only the member who asked can confirm.")];
  const command = await takePending(storage, row.userId, event.timestamp);
  if (!command) return [text("ℹ️ 這個確認已經過期了，請再說一次。Expired; please ask again.")];
  await handleEvent({ ...event, type: "message", postback: undefined, message: { type: "text", id: event.message?.id ?? `ok-${nonce}`, text: command } }, deps);
  return [];
}

/**
 * /activate [code]: switch the group on and bind it to an account, which pays
 * for it. Every member who activates gets an account (free unless a code
 * carries a plan); a fresh group bills to whoever activated it.
 *
 *   pending group                a one-time code is needed, unless the sender
 *                                already pays (their groups bill to them)
 *   active group, no code        an admin on a paid plan takes the billing over
 *   active group, with a code    the code's plan goes to the sender's account;
 *                                an admin's group moves to it unless that would
 *                                drop it to a lower plan
 */
async function activate(
  gid: string,
  group: GroupConfig | undefined,
  given: string | undefined,
  userId: string | undefined,
  deps: Deps,
  reply: (msg: string) => Promise<void>,
): Promise<void> {
  const ch = deps.channel.id;
  const admins = await deps.admins.list(gid);
  const accounts = deps.accounts;
  const own = userId && accounts ? await accounts.get(accountIdOf(ch, userId)) : undefined;
  const ownPlan = own ? effectivePlan(own.plan, own.planUntil) : undefined;
  const paying = own && ownPlan && ownPlan.id !== "free" ? own : undefined;
  const isActive = group?.status === "active" && admins.length > 0;
  const isAdmin = admins.some((a) => a.lineUserId === userId);
  const current = group?.accountId && accounts ? await accounts.get(group.accountId) : undefined;
  const currentPlan = current ? effectivePlan(current.plan, current.planUntil) : undefined;

  if (isActive && !given) {
    if (paying && isAdmin && group!.accountId !== paying.accountId) {
      await deps.groups.update(gid, { accountId: paying.accountId });
      return reply(`🔗 這個群組的用量改算在你的${ownPlan!.name}帳號（和你其他群組合計）。\nThis group now bills to your ${ownPlan!.name} account. /usage 查看用量`);
    }
    return reply(`✅ 此群組已啟用 Already active${currentPlan ? `（${currentPlan.name}）` : ""}。輸入 /help 查看指令`);
  }

  let code: ActivationCode | undefined;
  if (given) {
    code = await deps.codes.redeem(given, ch, gid, userId);
    if (!code) return reply("❌ 啟用碼無效、已使用或已過期\nThis code is invalid, already used or expired.");
  } else if (!paying) {
    return reply("請輸入啟用碼 Please add the code: /activate XXXX-XXXX-XXXX\n啟用碼請向服務提供者索取。");
  }

  if (!group) await deps.groups.register(defaultGroup(gid, ch)); // joined before registration existed
  if (!isActive) await deps.groups.activate(gid);
  const account =
    userId && accounts ? (code && code.plan !== "free" ? await accounts.grant(ch, userId, code.plan, code.planUntil) : await accounts.ensure(ch, userId)) : undefined;
  const plan = account ? effectivePlan(account.plan, account.planUntil) : undefined;
  const owner = !!userId && !admins.length;
  const moves =
    !!account &&
    group?.accountId !== account.accountId &&
    (!isActive || !group?.accountId || ((isAdmin || owner) && PLAN_RANK[plan!.id] >= PLAN_RANK[currentPlan?.id ?? "free"]));
  if (moves) await deps.groups.update(gid, { accountId: account!.accountId });
  if (owner) await deps.admins.add(gid, userId!, "owner");
  const active = await deps.groups.get(gid);
  return reply(
    [
      isActive ? "✅ 群組已啟用 Active" : "🎉 已啟用 Activated！",
      code ? "🔑 啟用碼已使用，無法再次使用。 This code is now used up." : "",
      plan ? `💎 你的方案 Your plan：${plan.name}${plan.id !== "free" && account!.planUntil ? `（到 ${account!.planUntil}）` : ""}` : "",
      moves ? "🔗 這個群組的用量算在你的帳號，和你其他群組合計；別的群組把我拉進去後，你輸入 /activate 也會算在一起。" : "",
      `功能 Plugins: ${active?.plugins.join(", ")}`,
      owner ? "👑 你是這個群組的管理員，輸入 /settings 開啟設定頁。\nYou are this group's admin; send /settings to open the settings page." : "",
      "輸入 /help 查看指令 Send /help to see commands.",
    ]
      .filter(Boolean)
      .join("\n"),
  );
}

/** /usage: this month's translation characters against the allowance, plus top-ups for accounts. */
async function usageText(group: GroupConfig, deps: Deps): Promise<string> {
  const plan = groupPlan(group);
  const account = group.account;
  const limit = account ? plan.monthlyChars : monthlyLimit(group.settings?.translate ?? {}, plan);
  const used = await deps.usage.get(account ? accountUsageKey(account.accountId) : group.groupId, USAGE_METRIC);
  const fmt = (n: number) => n.toLocaleString("en-US");
  const pct = limit ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  const until = account ? account.planUntil : group.planUntil;
  return [
    "📊 本月翻譯用量 Usage this month",
    `方案 Plan：${plan.name}${plan.id !== "free" && until ? `（到 ${until}）` : ""}`,
    limit ? `已用 Used：${fmt(used)} / ${fmt(limit)} 字（${pct}%）` : `已用 Used：${fmt(used)} 字（不限 unlimited）`,
    account ? `加購剩餘 Top-up left：${fmt(account.bonusChars)} 字` : "",
    account ? "（你綁定的所有群組合計 All your groups combined）" : "",
    plan.aiRequests ? `AI 助理 Assistant：${fmt(await deps.usage.get(account ? accountUsageKey(account.accountId) : group.groupId, AI_METRIC))} / ${fmt(plan.aiRequests)} 次` : "",
    limit && used >= limit
      ? plan.topUp
        ? `💡 額度用完時會自動扣加購字數；加購：/topup 加購碼（${fmt(TOP_UP.chars)} 字 NT$${TOP_UP.price}）`
        : "💡 額度用完了，下個月 1 日恢復；需要更多請升級。"
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** /topup <code>: add a top-up code's characters to the sender's per-user account. */
async function topUp(group: GroupConfig, given: string | undefined, userId: string | undefined, deps: Deps): Promise<string> {
  if (!deps.accounts) return "⚠️ 加購功能尚未開通。";
  if (!given) return "用法 Usage: /topup 加購碼\n例 e.g. /topup ABCD-EFGH-JKLM";
  const account = userId ? await deps.accounts.get(accountIdOf(deps.channel.id, userId)) : undefined;
  // Check first, so a code is not used up on an account that cannot take it.
  if (!account || !effectivePlan(account.plan, account.planUntil).topUp) return "加購只適用於進階版帳號。\nTop-ups are for Advanced accounts.";
  const code = await deps.codes.redeem(given, deps.channel.id, group.groupId, userId, new Date(), "topup");
  if (!code) return "❌ 加購碼無效、已使用或已過期\nThis code is invalid, already used or expired.";
  const updated = await deps.accounts.addBonus(account.accountId, code.chars ?? 0);
  return `✅ 已加購 ${(code.chars ?? 0).toLocaleString("en-US")} 字\n加購剩餘 Top-up left：${(updated?.bonusChars ?? 0).toLocaleString("en-US")} 字`;
}

/**
 * /confirm <code>: finish binding a settings-page login that opened this admin's
 * link from another provider (see session() in api.ts). The webhook's user ID
 * is the proof: only the admin the link was issued to can confirm.
 */
async function confirmBind(group: GroupConfig, given: string | undefined, userId: string | undefined, deps: Deps): Promise<string> {
  const code = (given ?? "").replace(/\D/g, "");
  if (!code) return "用法 Usage: /confirm 123456（設定頁上顯示的 6 位數字 the 6 digits shown on the settings page）";
  if (!userId) return "❌ 無法辨識你的身分 Could not identify you.";
  const pending = await deps.admins.takeBind(group.groupId, userId, code, new Date());
  if (!pending) return "❌ 確認碼不對、已過期，或不是給你的。請重新輸入 /settings。\nWrong or expired code, or not yours; send /settings again.";
  const res = await deps.admins.bindLogin(group.groupId, userId, pending.loginSub);
  if (res !== "ok") return "❌ 這個管理員身分已綁定其他 LINE 帳號 This admin is linked to another LINE account.";
  return `✅ 已將 LINE 登入帳號「${pending.loginName || pending.loginSub}」綁定為你的設定頁登入，回到設定頁即可繼續。\nLinked; go back to the settings page.`;
}

/** /settings: a single-use, 10-minute link to the settings page, only for admins. */
async function settingsLink(group: GroupConfig, userId: string | undefined, deps: Deps): Promise<LineMessage[]> {
  const admin = userId ? await deps.admins.get(group.groupId, userId) : undefined;
  if (!admin) return [text("🔒 只有管理員可以開啟設定頁，輸入 /admin 查看管理員。\nOnly admins can open the settings page; send /admin to see who they are.")];
  const { APP_SECRET, LIFF_ID } = deps.env;
  if (!APP_SECRET || !LIFF_ID) return [text("⚠️ 設定頁尚未開通（缺少 APP_SECRET 或 LIFF_ID）。\nThe settings page is not set up yet.")];

  // The channel tells the API whether chat and login IDs can be compared (see session() in api.ts).
  const token = await signToken(APP_SECRET, "link", { g: group.groupId, u: userId, n: randomId(), c: deps.channel.id }, LINK_TTL_SECONDS);
  const uri = `https://liff.line.me/${LIFF_ID}?link=${encodeURIComponent(token)}`;
  const name = (await deps.line.groupMemberName(group.groupId, userId!).catch(() => undefined)) ?? "管理員";
  return [
    {
      type: "template",
      altText: "⚙️ 設定頁連結 Settings link",
      template: {
        type: "buttons",
        text: `⚙️ ${name} 的設定頁連結\n10 分鐘內有效、只能用一次。\nValid 10 min, single use.`.slice(0, 160),
        actions: [{ type: "uri", label: "開啟設定 Open settings", uri }],
      },
    },
  ];
}

/** /report: a summary in chat and a 24-hour link to the full report with CSV downloads. */
async function reportReply(group: GroupConfig, deps: Deps): Promise<LineMessage[]> {
  if (!deps.env.APP_SECRET) return [text("⚠️ 報表功能尚未開通（缺少 APP_SECRET）。")];
  const data = await buildReport(group, deps.storageFor(group));
  const uri = await reportUrl(deps.env.APP_SECRET, deps.origin, group.groupId);
  return [
    {
      type: "template",
      altText: summaryText(data),
      template: {
        type: "buttons",
        text: summaryText(data).slice(0, 160),
        actions: [{ type: "uri", label: "開啟報表／下載 CSV", uri }],
      },
    },
  ];
}

/** /admin, /admin add @someone, /admin remove @someone. */
async function adminCommand(group: GroupConfig, args: string[], userId: string | undefined, event: LineEvent, deps: Deps): Promise<string> {
  const gid = group.groupId;
  const name = async (uid: string) => (await deps.line.groupMemberName(gid, uid).catch(() => undefined)) ?? uid.slice(0, 8);
  const sub = args[0]?.toLowerCase();

  if (!sub || sub === "list") {
    const admins = await deps.admins.list(gid);
    if (!admins.length) return "目前沒有管理員，輸入 /activate 認領。\nNo admins yet; send /activate to claim.";
    const lines = await Promise.all(admins.map(async (a) => `${a.role === "owner" ? "👑" : "🛡"} ${await name(a.lineUserId)}`));
    return `管理員 Admins\n${lines.join("\n")}\n\n新增：/admin add @成員`;
  }

  const me = userId ? await deps.admins.get(gid, userId) : undefined;
  if (!me) return "🔒 只有管理員可以變更管理員。\nOnly admins can change admins.";
  const targets = (event.message?.mention?.mentionees ?? []).map((m) => m.userId).filter((u): u is string => !!u);
  if (!targets.length) return `用法 Usage: /admin ${sub === "remove" ? "remove" : "add"} @成員（輸入 @ 選人）`;

  if (sub === "add") {
    for (const t of targets) await deps.admins.add(gid, t, "admin");
    return `🛡 已新增管理員 Added: ${(await Promise.all(targets.map(name))).join("、")}\n他們輸入 /settings 就能開設定頁。`;
  }
  if (sub === "remove") {
    if (me.role !== "owner") return "🔒 只有擁有者可以移除管理員。\nOnly the owner can remove admins.";
    const removable = targets.filter((t) => t !== userId);
    for (const t of removable) await deps.admins.remove(gid, t);
    return removable.length ? `已移除 Removed: ${(await Promise.all(removable.map(name))).join("、")}` : "擁有者不能移除自己。";
  }
  return "用法 Usage: /admin | /admin add @成員 | /admin remove @成員";
}

/** Cron entry: run every active group's plugins that have onSchedule, each through its own channel. */
export async function handleSchedule(
  cron: string,
  deps: Pick<Deps, "env" | "groups" | "usage" | "plugins" | "storageFor" | "outbox" | "accounts">,
  lineFor: (channelId: string) => Promise<LineApi | undefined>,
): Promise<void> {
  for (const group of await deps.groups.listActive()) {
    const line = await lineFor(group.channelId ?? "default").catch(() => undefined);
    if (!line) continue;
    if (group.accountId && deps.accounts) group.account = await deps.accounts.get(group.accountId);
    for (const name of group.plugins) {
      const plugin = deps.plugins[name];
      if (!plugin?.onSchedule) continue;
      try {
        await plugin.onSchedule(cron, context(deps, line, group, plugin));
      } catch (err) {
        console.error(`schedule ${name} for ${group.groupId} failed`, err);
      }
    }
  }
}
