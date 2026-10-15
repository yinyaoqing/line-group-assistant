/** A row is a flat record of strings; `id` is assigned by the storage. */
export type Row = Record<string, string> & { id: string };

/**
 * Minimal table storage every plugin uses. A "table" is a sheet tab in the
 * Sheets backend, so non-developers can read and fix data by hand.
 */
export interface Storage {
  list(table: string): Promise<Row[]>;
  append(table: string, row: Record<string, string>): Promise<Row>;
  update(table: string, id: string, patch: Record<string, string>): Promise<Row | undefined>;
}
