import { defaultGroup } from "../../config/defaults";
import { effectivePlan } from "../../config/plans";
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
  /** "open": groups activate as soon as the bot joins; "code": they need a one-time `/activate <code>`. */
  joinPolicy: "open" | "code";
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
}

/** LINE accepts at most this many messages per reply. */
const MAX_REPLY_MESSAGES = 5;

/**
 * How a group gets scheduled messages: "reply" (default) waits for the next
 * event and rides on its free reply; "push" sends at once, using LINE quota.
 */
export const notifyMode = (group: GroupConfig): "reply" | "push" => (group.settings?.core?.notify === "push" ? "push" : "reply");

/** How long a /settings link stays valid. */
export const LINK_TTL_SECONDS = 10 * 60;

const groupIdOf = (e: LineEvent) => e.source.groupId ?? e.source.roomId;

function context(deps: Pick<Deps, "env" | "usage" | "storageFor" | "outbox">, line: LineApi, group: GroupConfig, plugin: Plugin): PluginContext {
  const names = new Map<string, string | undefined>();
  return {
    env: deps.env,
    group,
    storage: deps.storageFor(group),
    settings: group.settings?.[plugin.name] ?? {},
    plan: effectivePlan(group.plan, group.planUntil),
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
      deps.outbox && notifyMode(group) === "reply" ? deps.outbox.add(group.groupId, messages) : line.push(group.groupId, messages),
    usage: {
      get: (metric) => deps.usage.get(group.groupId, metric),
      add: (metric, amount) => deps.usage.add(group.groupId, metric, amount),
    },
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

  // Bot just joined: register the group; open channels switch it on straight away.
  if (event.type === "join") {
    const name = await deps.line.groupName(gid).catch(() => undefined);
    await deps.groups.register({ ...defaultGroup(gid, deps.channel.id), name });
    if (deps.channel.joinPolicy === "open") await deps.groups.activate(gid);
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

  // "@bot …" in plain words: the AI assistant turns it into a command.
  const mentionees = event.message?.mention?.mentionees ?? [];
  if (!pre && mentionees.some((m) => m.isSelf)) {
    const reply = await assistantReply(stripSelfMention(input, mentionees), group, active, userId, deps);
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
): Promise<{ run?: string; messages: LineMessage[] }> {
  const say = (msg: string) => ({ messages: [text(msg)] });
  if (!effectivePlan(group.plan, group.planUntil).ai) {
    return say("🤖 用說的操作（AI 助理）是專業版功能。\nAI requests are a Pro feature. 輸入 /menu 用按鈕操作。");
  }
  if (!deps.env.ANTHROPIC_API_KEY) return say("⚠️ AI 助理尚未開通（缺少 ANTHROPIC_API_KEY）。");
  if (!request) return say("🤖 有什麼需要幫忙？例如：「@我 新增任務 明天買螺絲 給阿明」\nHow can I help? e.g. \"@me add a task: buy screws tomorrow\"");

  const ctx = context(deps, deps.line, group, { name: "assistant" });
  try {
    const [data, speaker] = await Promise.all([gatherContext(ctx), ctx.displayName(userId).then((n) => n ?? "member")]);
    const today = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
    const decision = await interpret(deps.env, { request, speaker, plugins: active, today, ...data });
    await ctx.usage.add(AI_METRIC, 1);
    if (decision.kind === "answer") return say(`🤖 ${decision.reply}`);
    if (isReadOnly(decision.command)) return { run: decision.command, messages: [] };
    // Anything that changes data waits for a tap, so a misread request is never applied silently.
    return {
      messages: [
        {
          type: "template",
          altText: `🤖 ${decision.reply}`.slice(0, 400),
          template: {
            type: "buttons",
            text: `🤖 ${decision.reply}\n${decision.command}`.slice(0, 160),
            actions: [action({ label: "✓ 執行 Confirm", text: decision.command })],
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
 * /activate [code]: switch the group on (checking the channel's code when it
 * needs one), and make the sender the owner if the group has no admins yet.
 */
async function activate(
  gid: string,
  group: GroupConfig | undefined,
  given: string | undefined,
  userId: string | undefined,
  deps: Deps,
  reply: (msg: string) => Promise<void>,
): Promise<void> {
  const admins = await deps.admins.list(gid);
  if (group?.status === "active" && admins.length) return reply("✅ 此群組已啟用 Already active. 輸入 /help 查看指令");

  // Code channels need a one-time code; it is used up here, whether it activates
  // the group or claims an already-active group that has no admin yet.
  let code: ActivationCode | undefined;
  if (deps.channel.joinPolicy === "code") {
    if (!given) return reply("請輸入啟用碼 Please add the code: /activate XXXX-XXXX-XXXX\n啟用碼請向服務提供者索取。");
    code = await deps.codes.redeem(given, deps.channel.id, gid, userId);
    if (!code) return reply("❌ 啟用碼無效、已使用或已過期\nThis code is invalid, already used or expired.");
  }

  if (!group) await deps.groups.register(defaultGroup(gid, deps.channel.id)); // joined before registration existed
  await deps.groups.activate(gid);
  // A code can start the group on a paid plan.
  const active = code && code.plan !== "free" ? await deps.groups.update(gid, { plan: code.plan, planUntil: code.planUntil ?? "" }) : await deps.groups.get(gid);
  const owner = userId && !admins.length;
  if (owner) await deps.admins.add(gid, userId, "owner");
  const plan = active && effectivePlan(active.plan, active.planUntil);
  return reply(
    [
      group?.status === "active" ? "✅ 群組已啟用 Active" : "🎉 已啟用 Activated！",
      code ? "🔑 啟用碼已使用，無法再次使用。 This code is now used up." : "",
      plan && plan.id !== "free" ? `💎 方案 Plan：${plan.name}${active?.planUntil ? `（到 ${active.planUntil}）` : ""}` : "",
      `功能 Plugins: ${active?.plugins.join(", ")}`,
      owner ? "👑 你是這個群組的管理員，輸入 /settings 開啟設定頁。\nYou are this group's admin; send /settings to open the settings page." : "",
      "輸入 /help 查看指令 Send /help to see commands.",
    ]
      .filter(Boolean)
      .join("\n"),
  );
}

/** /settings: a single-use, 10-minute link to the settings page, only for admins. */
async function settingsLink(group: GroupConfig, userId: string | undefined, deps: Deps): Promise<LineMessage[]> {
  const admin = userId ? await deps.admins.get(group.groupId, userId) : undefined;
  if (!admin) return [text("🔒 只有管理員可以開啟設定頁，輸入 /admin 查看管理員。\nOnly admins can open the settings page; send /admin to see who they are.")];
  const { APP_SECRET, LIFF_ID } = deps.env;
  if (!APP_SECRET || !LIFF_ID) return [text("⚠️ 設定頁尚未開通（缺少 APP_SECRET 或 LIFF_ID）。\nThe settings page is not set up yet.")];

  const token = await signToken(APP_SECRET, "link", { g: group.groupId, u: userId, n: randomId() }, LINK_TTL_SECONDS);
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
  deps: Pick<Deps, "env" | "groups" | "usage" | "plugins" | "storageFor" | "outbox">,
  lineFor: (channelId: string) => Promise<LineApi | undefined>,
): Promise<void> {
  for (const group of await deps.groups.listActive()) {
    const line = await lineFor(group.channelId ?? "default").catch(() => undefined);
    if (!line) continue;
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
