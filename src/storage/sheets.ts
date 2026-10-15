import type { Row, Storage } from "./types";

/**
 * Google Sheets backend. Each table is a tab; row 1 holds the column headers
 * and must include "id". Tabs and new columns are created on demand.
 * Authenticates as a service account; share the spreadsheet with its email.
 */
export class SheetsStorage implements Storage {
  private token?: { value: string; exp: number };
  private known = new Set<string>();

  constructor(
    private sheetId: string,
    private serviceAccountJson: string,
    private fetchFn: typeof fetch = fetch,
  ) {}

  // ---------- public API ----------

  async list(table: string): Promise<Row[]> {
    const { headers, rows } = await this.read(table);
    return rows.map((cells) => toRow(headers, cells)).filter((r) => r.id);
  }

  async append(table: string, row: Record<string, string>): Promise<Row> {
    const { headers, rows } = await this.read(table);
    const nextId = String(rows.reduce((m, c) => Math.max(m, Number(c[headers.indexOf("id")]) || 0), 0) + 1);
    const full = { ...row, id: nextId } as Row;
    const cols = await this.ensureColumns(table, headers, Object.keys(full));
    await this.api(`/values/${enc(table)}!A1:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, {
      method: "POST",
      body: JSON.stringify({ values: [cols.map((h) => full[h] ?? "")] }),
    });
    return full;
  }

  async update(table: string, id: string, patch: Record<string, string>): Promise<Row | undefined> {
    const { headers, rows } = await this.read(table);
    const idx = rows.findIndex((c) => c[headers.indexOf("id")] === id);
    if (idx < 0) return undefined;
    const merged = { ...toRow(headers, rows[idx]!), ...patch, id } as Row;
    const cols = await this.ensureColumns(table, headers, Object.keys(merged));
    const rowNumber = idx + 2; // +1 for header, +1 for 1-based
    await this.api(`/values/${enc(table)}!A${rowNumber}?valueInputOption=RAW`, {
      method: "PUT",
      body: JSON.stringify({ values: [cols.map((h) => merged[h] ?? "")] }),
    });
    return merged;
  }

  // ---------- internals ----------

  private async read(table: string): Promise<{ headers: string[]; rows: string[][] }> {
    await this.ensureTab(table);
    const res = await this.api(`/values/${enc(table)}!A1:ZZ`, { method: "GET" });
    const data = (await res.json()) as { values?: string[][] };
    const [headers = ["id"], ...rows] = data.values ?? [];
    return { headers, rows };
  }

  private async ensureTab(table: string): Promise<void> {
    if (this.known.has(table)) return;
    const res = await this.api(`?fields=sheets.properties.title`, { method: "GET" });
    const meta = (await res.json()) as { sheets?: { properties: { title: string } }[] };
    for (const s of meta.sheets ?? []) this.known.add(s.properties.title);
    if (this.known.has(table)) return;
    await this.api(`:batchUpdate`, {
      method: "POST",
      body: JSON.stringify({ requests: [{ addSheet: { properties: { title: table } } }] }),
    });
    await this.writeHeaders(table, ["id"]);
    this.known.add(table);
  }

  private async ensureColumns(table: string, headers: string[], keys: string[]): Promise<string[]> {
    const missing = keys.filter((k) => !headers.includes(k));
    if (!missing.length) return headers;
    const next = [...headers, ...missing];
    await this.writeHeaders(table, next);
    return next;
  }

  private async writeHeaders(table: string, headers: string[]): Promise<void> {
    await this.api(`/values/${enc(table)}!A1?valueInputOption=RAW`, {
      method: "PUT",
      body: JSON.stringify({ values: [headers] }),
    });
  }

  private async api(path: string, init: RequestInit): Promise<Response> {
    const res = await this.fetchFn(`https://sheets.googleapis.com/v4/spreadsheets/${this.sheetId}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${await this.accessToken()}`, "Content-Type": "application/json" },
    });
    if (!res.ok) throw new Error(`Sheets ${path} failed: ${res.status} ${await res.text()}`);
    return res;
  }

  /** OAuth2 JWT bearer flow for a service account, signed with WebCrypto. */
  private async accessToken(): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    if (this.token && this.token.exp - 60 > now) return this.token.value;
    const sa = JSON.parse(this.serviceAccountJson) as { client_email: string; private_key: string };
    const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const claim = b64url(
      JSON.stringify({
        iss: sa.client_email,
        scope: "https://www.googleapis.com/auth/spreadsheets",
        aud: "https://oauth2.googleapis.com/token",
        iat: now,
        exp: now + 3600,
      }),
    );
    const pem = sa.private_key.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
    const der = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));
    const key = await crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
    const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${header}.${claim}`)));
    const jwt = `${header}.${claim}.${b64url(sig)}`;
    const res = await this.fetchFn("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
    });
    if (!res.ok) throw new Error(`Google token failed: ${res.status} ${await res.text()}`);
    const data = (await res.json()) as { access_token: string; expires_in: number };
    this.token = { value: data.access_token, exp: now + data.expires_in };
    return data.access_token;
  }
}

const enc = (s: string) => encodeURIComponent(`'${s.replace(/'/g, "''")}'`);

function toRow(headers: string[], cells: string[]): Row {
  const r: Record<string, string> = {};
  headers.forEach((h, i) => (r[h] = cells[i] ?? ""));
  return r as Row;
}

function b64url(input: string | Uint8Array): string {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
