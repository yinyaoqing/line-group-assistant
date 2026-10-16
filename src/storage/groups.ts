import type { GroupConfig } from "../core/types";

/** Fields of a group that the settings and admin pages may change. */
export type GroupPatch = Partial<Pick<GroupConfig, "name" | "status" | "plugins" | "settings" | "storage" | "plan" | "planUntil">>;

/** Where group configurations live; replaces the old hard-coded config/groups.ts. */
export interface GroupRepo {
  get(groupId: string): Promise<GroupConfig | undefined>;
  /**
   * Record a group the bot was invited to, as 'pending'. An existing group keeps
   * its settings; one the bot had left goes back to 'pending'.
   */
  register(group: GroupConfig): Promise<void>;
  activate(groupId: string): Promise<GroupConfig | undefined>;
  update(groupId: string, patch: GroupPatch): Promise<GroupConfig | undefined>;
  listActive(): Promise<GroupConfig[]>;
  listAll(): Promise<GroupConfig[]>;
}

/** Metered usage per group and calendar month (Taipei time). */
export interface UsageMeter {
  get(groupId: string, metric: string, at?: Date): Promise<number>;
  add(groupId: string, metric: string, amount: number, at?: Date): Promise<void>;
}

/** "2026-10" for the month `at` falls in, in Taipei time (UTC+8). */
export const monthKey = (at = new Date()) => new Date(at.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 7);

// ---------- D1 ----------

interface GroupRecord {
  group_id: string;
  name: string | null;
  status: string;
  plugins: string;
  settings: string;
  storage: string;
  channel_id: string;
  plan: string;
  plan_until: string | null;
}

const STATUSES = ["pending", "active", "left"] as const;

const fromRecord = (r: GroupRecord): GroupConfig => ({
  groupId: r.group_id,
  name: r.name ?? undefined,
  status: STATUSES.find((s) => s === r.status) ?? "pending",
  channelId: r.channel_id,
  plan: r.plan,
  planUntil: r.plan_until ?? undefined,
  plugins: JSON.parse(r.plugins) as string[],
  settings: JSON.parse(r.settings) as GroupConfig["settings"],
  storage: JSON.parse(r.storage) as GroupConfig["storage"],
});

/** GroupPatch keys → columns; JSON columns are stringified. */
const COLUMNS: Record<keyof GroupPatch, [string, boolean]> = {
  name: ["name", false],
  status: ["status", false],
  plugins: ["plugins", true],
  settings: ["settings", true],
  storage: ["storage", true],
  plan: ["plan", false],
  planUntil: ["plan_until", false],
};

export class D1GroupRepo implements GroupRepo {
  constructor(private db: D1Database) {}

  async get(groupId: string) {
    const r = await this.db.prepare("SELECT * FROM groups WHERE group_id = ?").bind(groupId).first<GroupRecord>();
    return r ? fromRecord(r) : undefined;
  }

  async register(g: GroupConfig) {
    await this.db
      .prepare(
        `INSERT INTO groups (group_id, name, status, plugins, settings, storage, channel_id, plan)
         VALUES (?, ?, 'pending', ?, ?, ?, ?, ?)
         ON CONFLICT (group_id) DO UPDATE SET
           status = CASE WHEN status = 'left' THEN 'pending' ELSE status END,
           name = COALESCE(excluded.name, name),
           updated_at = datetime('now')`,
      )
      .bind(
        g.groupId,
        g.name ?? null,
        JSON.stringify(g.plugins),
        JSON.stringify(g.settings ?? {}),
        JSON.stringify(g.storage ?? { type: "d1" }),
        g.channelId ?? "default",
        g.plan ?? "free",
      )
      .run();
  }

  async activate(groupId: string) {
    return this.update(groupId, { status: "active" });
  }

  async update(groupId: string, patch: GroupPatch) {
    const entries = (Object.keys(patch) as (keyof GroupPatch)[]).filter((k) => k in COLUMNS && patch[k] !== undefined);
    if (entries.length) {
      const sets = entries.map((k) => `${COLUMNS[k][0]} = ?`).join(", ");
      const values = entries.map((k) => (COLUMNS[k][1] ? JSON.stringify(patch[k]) : (patch[k] as string)));
      await this.db
        .prepare(`UPDATE groups SET ${sets}, updated_at = datetime('now') WHERE group_id = ?`)
        .bind(...values, groupId)
        .run();
    }
    return this.get(groupId);
  }

  async listActive() {
    const { results } = await this.db.prepare("SELECT * FROM groups WHERE status = 'active'").all<GroupRecord>();
    return results.map(fromRecord);
  }

  async listAll() {
    const { results } = await this.db.prepare("SELECT * FROM groups ORDER BY created_at DESC").all<GroupRecord>();
    return results.map(fromRecord);
  }
}

export class D1UsageMeter implements UsageMeter {
  constructor(private db: D1Database) {}

  async get(groupId: string, metric: string, at?: Date) {
    const r = await this.db
      .prepare("SELECT amount FROM usage WHERE group_id = ? AND month = ? AND metric = ?")
      .bind(groupId, monthKey(at), metric)
      .first<{ amount: number }>();
    return r?.amount ?? 0;
  }

  async add(groupId: string, metric: string, amount: number, at?: Date) {
    await this.db
      .prepare(
        `INSERT INTO usage (group_id, month, metric, amount) VALUES (?, ?, ?, ?)
         ON CONFLICT (group_id, month, metric) DO UPDATE SET amount = amount + excluded.amount`,
      )
      .bind(groupId, monthKey(at), metric, amount)
      .run();
  }
}

// ---------- memory (tests, local dev) ----------

export class MemoryGroupRepo implements GroupRepo {
  constructor(public groups: GroupConfig[] = []) {}

  async get(groupId: string) {
    return this.groups.find((g) => g.groupId === groupId);
  }

  async register(g: GroupConfig) {
    const existing = await this.get(g.groupId);
    if (!existing) this.groups.push({ channelId: "default", plan: "free", ...g, status: "pending" });
    else if (existing.status === "left") existing.status = "pending";
  }

  async activate(groupId: string) {
    return this.update(groupId, { status: "active" });
  }

  async update(groupId: string, patch: GroupPatch) {
    const g = await this.get(groupId);
    if (g) Object.assign(g, Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)));
    return g;
  }

  async listActive() {
    return this.groups.filter((g) => g.status === "active");
  }

  async listAll() {
    return [...this.groups];
  }
}

export class MemoryUsageMeter implements UsageMeter {
  private counts = new Map<string, number>();

  async get(groupId: string, metric: string, at?: Date) {
    return this.counts.get(`${groupId}|${monthKey(at)}|${metric}`) ?? 0;
  }

  async add(groupId: string, metric: string, amount: number, at?: Date) {
    const k = `${groupId}|${monthKey(at)}|${metric}`;
    this.counts.set(k, (this.counts.get(k) ?? 0) + amount);
  }
}
