import type { LineMessage } from "../core/types";

/**
 * Messages queued for a group's next reply (free) instead of a push (counted
 * against the LINE quota). See migrations/0005_outbox.sql.
 */
export interface OutboxRepo {
  add(groupId: string, messages: LineMessage[]): Promise<void>;
  /** Remove and return up to `limit` of the group's oldest queued messages. */
  take(groupId: string, limit: number): Promise<LineMessage[]>;
}

export class D1OutboxRepo implements OutboxRepo {
  constructor(private db: D1Database) {}

  async add(groupId: string, messages: LineMessage[]) {
    if (!messages.length) return;
    await this.db.batch(messages.map((m) => this.db.prepare("INSERT INTO outbox (group_id, message) VALUES (?, ?)").bind(groupId, JSON.stringify(m))));
  }

  async take(groupId: string, limit: number) {
    if (limit <= 0) return [];
    // Deleting and returning in one statement means two concurrent events never send the same message twice.
    const { results } = await this.db
      .prepare("DELETE FROM outbox WHERE id IN (SELECT id FROM outbox WHERE group_id = ? ORDER BY id LIMIT ?) RETURNING id, message")
      .bind(groupId, limit)
      .all<{ id: number; message: string }>();
    return results.sort((a, b) => a.id - b.id).map((r) => JSON.parse(r.message) as LineMessage);
  }
}

export class MemoryOutboxRepo implements OutboxRepo {
  queued = new Map<string, LineMessage[]>();

  async add(groupId: string, messages: LineMessage[]) {
    this.queued.set(groupId, [...(this.queued.get(groupId) ?? []), ...messages]);
  }

  async take(groupId: string, limit: number) {
    const all = this.queued.get(groupId) ?? [];
    const out = all.slice(0, Math.max(0, limit));
    this.queued.set(groupId, all.slice(out.length));
    return out;
  }
}
