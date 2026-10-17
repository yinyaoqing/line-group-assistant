import type { Plan } from "../../config/plans";
import type { Storage } from "../storage/types";

/** Secrets and bindings provided by the Workers runtime. */
export interface Env {
  LINE_CHANNEL_SECRET: string;
  LINE_CHANNEL_ACCESS_TOKEN: string;
  GOOGLE_SERVICE_ACCOUNT_JSON?: string;
  GOOGLE_TRANSLATE_API_KEY?: string;
  DEEPL_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  /** Groups, plugin tables and usage. */
  DB: D1Database;
  /** Signs settings-page links and sessions, and encrypts white-label channel credentials. */
  APP_SECRET?: string;
  /** LIFF app that hosts the settings page, and the LINE Login channel it belongs to. */
  LIFF_ID?: string;
  LOGIN_CHANNEL_ID?: string;
  /** Comma-separated LINE Login user IDs allowed into the platform admin page. */
  PLATFORM_ADMINS?: string;
  /** Claude model for "@bot" requests; defaults to DEFAULT_AI_MODEL in core/assistant.ts. */
  AI_MODEL?: string;
  /** "1" only in local development: lets the settings page skip LINE Login. Never set in production. */
  DEV_MODE?: string;
}

/** A LINE message object (text only is used by the bundled plugins). */
export type LineMessage = { type: "text"; text: string } | Record<string, unknown>;

/** Subset of a LINE webhook event the core understands. */
export interface LineEvent {
  type: string;
  replyToken?: string;
  timestamp: number;
  source: { type: "group" | "room" | "user"; groupId?: string; roomId?: string; userId?: string };
  message?: {
    type: string;
    id: string;
    text?: string;
    /** People @-mentioned in a text message; isSelf marks a mention of this bot. */
    mention?: { mentionees: { index: number; length: number; userId?: string; type?: string; isSelf?: boolean }[] };
    /** ID of the message this one quotes (LINE's long-press "Reply"). */
    quotedMessageId?: string;
  };
  /** Button taps (postback actions): the data is the command the button stands for. */
  postback?: { data: string };
  /** memberJoined events: who joined. */
  joined?: { members: { type: string; userId?: string }[] };
}

/** Per-group configuration. `plugins` lists which plugins run, in order. */
export interface GroupConfig {
  groupId: string;
  name?: string;
  /** Only active groups run plugins; invited groups wait as pending until /activate; "left" after the bot is removed. */
  status?: "pending" | "active" | "left";
  /** The LINE channel (official account) the group belongs to; "default" is the one in the Worker's secrets. */
  channelId?: string;
  /** Plan id ("free" | "pro") and, for paid plans, the last day it is paid for (YYYY-MM-DD). */
  plan?: string;
  planUntil?: string;
  plugins: string[];
  storage?: { type: "d1" } | { type: "sheets"; sheetId: string } | { type: "memory" };
  /** Plugin-specific settings, keyed by plugin name. */
  settings?: Record<string, Record<string, unknown>>;
}

/** What the core hands to every plugin call. */
export interface PluginContext {
  env: Env;
  group: GroupConfig;
  storage: Storage;
  /** Settings for the plugin being called (group.settings[plugin.name] or {}). */
  settings: Record<string, unknown>;
  /** Resolve a member's display name; returns undefined if LINE won't say. */
  displayName(userId: string | undefined): Promise<string | undefined>;
  /**
   * Send to the group outside a reply (scheduled jobs). By default it waits for
   * the group's next event and rides on that free reply; groups set to "push"
   * get it at once, which counts against the monthly message quota.
   */
  push(messages: LineMessage[]): Promise<void>;
  /** The group's plan in force (expired paid plans count as free). */
  plan: Plan;
  /** This group's metered usage for the current month, e.g. "translate_chars". */
  usage: {
    get(metric: string): Promise<number>;
    add(metric: string, amount: number): Promise<void>;
  };
}

export interface MessageInput {
  text: string;
  userId?: string;
  event: LineEvent;
}

export interface CommandInput extends MessageInput {
  /** Command name without the slash, e.g. "任務". */
  name: string;
  /** Whitespace-split arguments after the command name. */
  args: string[];
  /** Raw text after the command name. */
  rest: string;
}

/**
 * A plugin returns messages to reply with. The core merges every plugin's
 * replies into one reply call (a reply token can only be used once, max 5
 * messages), so replies never count against the push quota.
 */
export interface Plugin {
  name: string;
  /** Commands this plugin handles, without the slash. */
  commands?: string[];
  /** Called for every plain (non-command) text message. */
  onMessage?(input: MessageInput, ctx: PluginContext): Promise<LineMessage[] | void>;
  /** Called when a message starts with "/" + one of `commands`. */
  onCommand?(input: CommandInput, ctx: PluginContext): Promise<LineMessage[] | void>;
  /** Called by the cron trigger. Use ctx.push to send (costs quota). */
  onSchedule?(cron: string, ctx: PluginContext): Promise<void>;
  /** This plugin's section of /help: a title and one line per command, with an example. */
  help?: { title: string; lines: string[] };
  /** Fill-in-the-blanks commands for /template, which people copy, edit and send. */
  templates?: Template[];
  /** Buttons offered under every command reply, so phone users can tap instead of type. */
  quickReplies?: QuickItem[];
  /** Called when people join the group; may reply, e.g. to ask their language. */
  onMemberJoined?(userIds: string[], ctx: PluginContext): Promise<LineMessage[] | void>;
  /**
   * Called after a reply went out with the LINE message ID of each message this
   * plugin tagged with `tag(message, key)`, so it can map later quotes back to `key`.
   */
  onSent?(key: string, messageId: string, ctx: PluginContext): Promise<void>;
}

/** A command to copy and edit, e.g. "/add 工作內容 @負責人 10/20". */
export interface Template {
  label: string;
  text: string;
  /** Short hint shown under the template, e.g. which parts are optional. */
  note?: string;
}

/**
 * A button for a command. Tapping it runs `text` as a postback, so nothing is
 * posted to the chat; the bot's reply says who tapped.
 */
export interface QuickItem {
  label: string;
  text: string;
}

export const text = (t: string): LineMessage => ({ type: "text", text: t.slice(0, 5000) });

/** LINE allows at most 13 quick reply buttons, each label at most 20 characters. */
const MAX_QUICK = 13;

/** Attach quick reply buttons to a message, after any it already has (duplicates dropped). */
export function withQuickReply(message: LineMessage, items: QuickItem[]): LineMessage {
  const current = (message as { quickReply?: { items?: { action: QuickAction }[] } }).quickReply;
  const existing = (current?.items ?? []).map((i) => i.action);
  const seen = new Set(existing.map((a) => a.data));
  const added = items.filter((i) => !seen.has(i.text) && seen.add(i.text)).map(action);
  const all = [...existing, ...added].slice(0, MAX_QUICK);
  if (!all.length) return message;
  const out: LineMessage = { ...message, quickReply: { items: all.map((a) => ({ type: "action", action: a })) } };
  const t = tagOf(message);
  return t ? tag(out, t.plugin, t.key) : out;
}

type QuickAction = { type: "postback"; label: string; data: string };

/** A postback action for a command; LINE caps labels at 20 characters and data at 300. */
export const action = (i: QuickItem): QuickAction => ({ type: "postback", label: i.label.slice(0, 20), data: i.text.slice(0, 300) });

/**
 * Tag a message with a plugin key (e.g. a task id). The tag is not sent to LINE;
 * after the reply, the plugin's onSent gets the LINE message ID for it.
 */
export function tag(message: LineMessage, plugin: string, key: string): LineMessage {
  Object.defineProperty(message, "_tag", { value: { plugin, key }, enumerable: false });
  return message;
}

export const tagOf = (message: LineMessage): { plugin: string; key: string } | undefined => (message as { _tag?: { plugin: string; key: string } })._tag;
