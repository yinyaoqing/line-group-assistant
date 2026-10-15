import type { Storage } from "../storage/types";

/** Secrets and bindings provided by the Workers runtime. */
export interface Env {
  LINE_CHANNEL_SECRET: string;
  LINE_CHANNEL_ACCESS_TOKEN: string;
  GOOGLE_SERVICE_ACCOUNT_JSON?: string;
  GOOGLE_TRANSLATE_API_KEY?: string;
  DEEPL_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
}

/** A LINE message object (text only is used by the bundled plugins). */
export type LineMessage = { type: "text"; text: string } | Record<string, unknown>;

/** Subset of a LINE webhook event the core understands. */
export interface LineEvent {
  type: string;
  replyToken?: string;
  timestamp: number;
  source: { type: "group" | "room" | "user"; groupId?: string; roomId?: string; userId?: string };
  message?: { type: string; id: string; text?: string };
}

/** Per-group configuration. `plugins` lists which plugins run, in order. */
export interface GroupConfig {
  groupId: string;
  name?: string;
  plugins: string[];
  storage?: { type: "sheets"; sheetId: string } | { type: "memory" };
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
}

export const text = (t: string): LineMessage => ({ type: "text", text: t.slice(0, 5000) });
