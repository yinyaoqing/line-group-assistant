import type { Row, Storage } from "./types";

/** In-memory storage for tests and local dev. Data is lost on restart. */
export class MemoryStorage implements Storage {
  private tables = new Map<string, Row[]>();
  private seq = 0;

  async list(table: string): Promise<Row[]> {
    return [...(this.tables.get(table) ?? [])];
  }

  async append(table: string, row: Record<string, string>): Promise<Row> {
    const r = { ...row, id: String(++this.seq) } as Row;
    this.tables.set(table, [...(this.tables.get(table) ?? []), r]);
    return r;
  }

  async update(table: string, id: string, patch: Record<string, string>): Promise<Row | undefined> {
    const rows = this.tables.get(table) ?? [];
    const i = rows.findIndex((r) => r.id === id);
    if (i < 0) return undefined;
    const r = { ...rows[i]!, ...patch, id } as Row;
    rows[i] = r;
    return r;
  }
}
