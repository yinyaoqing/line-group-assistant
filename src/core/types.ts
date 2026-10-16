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
  /** Code a group sends as "/activate <code>" to turn the bot on; unset = no activation from chat. */
  ACTIVATION_CODE?: string;
  /** Signs settings-page links and sessions, and encrypts white-label channel credentials. */
  APP_SECRET?: string;
  /** LIFF app that hosts the settings page, and the LINE Login channel it belongs to. */
  LIFF_ID?: string;
  LOGIN_CHANNEL_ID?: string;
  /** Comma-separated LINE Login user IDs allowed into the platform admin page. */
  PLATFORM_ADMINS?: string;
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
    /** People @-mentioned in a text message. */
    mention?: { mentionees: { index: number; length: number; userId?: string; type?: string }[] };
  };
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
  /** Push messages to the group. Counts against the monthly message quota. */
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
}

/** A command to copy and edit, e.g. "/add 工作內容 @負責人 10/20". */
export interface Template {
  label: string;
  text: string;
  /** Short hint shown under the template, e.g. which parts are optional. */
  note?: string;
}

/** A tap-to-send button: tapping posts `text` to the chat as the user's own message. */
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
  const seen = new Set(existing.map((a) => a.text));
  const added = items.filter((i) => !seen.has(i.text) && seen.add(i.text)).map(action);
  const all = [...existing, ...added].slice(0, MAX_QUICK);
  if (!all.length) return message;
  return { ...message, quickReply: { items: all.map((a) => ({ type: "action", action: a })) } };
}

type QuickAction = { type: "message"; label: string; text: string };

export const action = (i: QuickItem): QuickAction => ({ type: "message", label: i.label.slice(0, 20), text: i.text });
