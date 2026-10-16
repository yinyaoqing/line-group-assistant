import type { Row, Storage } from "./types";

/**
 * Cloudflare D1 backend: every table of one group lives in the shared
 * "records" table, keyed by (group_id, tbl, id). Ids come from "counters",
 * which is bumped in a single statement so concurrent appends never collide.
 */
export class D1Storage implements Storage {
  constructor(private db: D1Database, private groupId: string) {}

  async list(table: string): Promise<Row[]> {
    const { results } = await this.db
      .prepare("SELECT id, data FROM records WHERE group_id = ? AND tbl = ? ORDER BY id")
      .bind(this.groupId, table)
      .all<{ id: number; data: string }>();
    return results.map((r) => toRow(r.id, r.data));
  }

  async append(table: string, row: Record<string, string>): Promise<Row> {
    const next = await this.db
      .prepare(
        `INSERT INTO counters (group_id, tbl, last_id) VALUES (?, ?, 1)
         ON CONFLICT (group_id, tbl) DO UPDATE SET last_id = last_id + 1
         RETURNING last_id`,
      )
      .bind(this.groupId, table)
      .first<{ last_id: number }>();
    const id = next!.last_id;
    const { id: _ignored, ...fields } = row;
    await this.db
      .prepare("INSERT INTO records (group_id, tbl, id, data) VALUES (?, ?, ?, ?)")
      .bind(this.groupId, table, id, JSON.stringify(fields))
      .run();
    return { ...fields, id: String(id) } as Row;
  }

  async update(table: string, id: string, patch: Record<string, string>): Promise<Row | undefined> {
    const num = Number(id);
    if (!Number.isInteger(num)) return undefined;
    const current = await this.db
      .prepare("SELECT data FROM records WHERE group_id = ? AND tbl = ? AND id = ?")
      .bind(this.groupId, table, num)
      .first<{ data: string }>();
    if (!current) return undefined;
    const { id: _ignored, ...fields } = { ...(JSON.parse(current.data) as Record<string, string>), ...patch };
    await this.db
      .prepare("UPDATE records SET data = ? WHERE group_id = ? AND tbl = ? AND id = ?")
      .bind(JSON.stringify(fields), this.groupId, table, num)
      .run();
    return { ...fields, id: String(num) } as Row;
  }
}

const toRow = (id: number, data: string): Row => ({ ...(JSON.parse(data) as Record<string, string>), id: String(id) }) as Row;
