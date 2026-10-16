/** A one-time activation code. */
export interface ActivationCode {
  /** Normalised form: upper case letters and digits, no dashes. */
  code: string;
  label: string;
  channelId: string;
  plan: string;
  planUntil?: string;
  expiresAt?: string;
  createdBy?: string;
  createdAt?: string;
  usedGroup?: string;
  usedBy?: string;
  usedAt?: string;
}

export type NewCode = Pick<ActivationCode, "label" | "channelId" | "plan" | "planUntil" | "expiresAt" | "createdBy">;

export interface CodeRepo {
  create(spec: NewCode): Promise<ActivationCode>;
  list(limit?: number): Promise<ActivationCode[]>;
  /**
   * Use a code for a group, once: succeeds only for an unused, unexpired code of
   * this channel, and marks it used in the same step so it cannot be used twice.
   */
  redeem(input: string, channelId: string, groupId: string, userId: string | undefined, now?: Date): Promise<ActivationCode | undefined>;
  /** Delete an unused code; returns false if it was used or does not exist. */
  revoke(code: string): Promise<boolean>;
}

// No 0/O, 1/I/L: codes are read off a screen and typed on a phone.
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const CODE_LENGTH = 12;

/** "k7qm-3xrp 9wta" → "K7QM3XRP9WTA". */
export const normalizeCode = (s: string) => s.toUpperCase().replace(/[^0-9A-Z]/g, "");

/** "K7QM3XRP9WTA" → "K7QM-3XRP-9WTA", for showing and copying. */
export const formatCode = (code: string) => code.match(/.{1,4}/g)?.join("-") ?? code;

export function newCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_LENGTH));
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join("");
}

interface CodeRecord {
  code: string;
  label: string;
  channel_id: string;
  plan: string;
  plan_until: string | null;
  expires_at: string | null;
  created_by: string | null;
  created_at: string;
  used_group: string | null;
  used_by: string | null;
  used_at: string | null;
}

const fromRecord = (r: CodeRecord): ActivationCode => ({
  code: r.code,
  label: r.label,
  channelId: r.channel_id,
  plan: r.plan,
  planUntil: r.plan_until ?? undefined,
  expiresAt: r.expires_at ?? undefined,
  createdBy: r.created_by ?? undefined,
  createdAt: r.created_at,
  usedGroup: r.used_group ?? undefined,
  usedBy: r.used_by ?? undefined,
  usedAt: r.used_at ?? undefined,
});

export class D1CodeRepo implements CodeRepo {
  constructor(private db: D1Database) {}

  async create(spec: NewCode) {
    const code = newCode();
    await this.db
      .prepare("INSERT INTO activation_codes (code, label, channel_id, plan, plan_until, expires_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(code, spec.label, spec.channelId, spec.plan, spec.planUntil ?? null, spec.expiresAt ?? null, spec.createdBy ?? null)
      .run();
    return { ...spec, code };
  }

  async list(limit = 200) {
    const { results } = await this.db.prepare("SELECT * FROM activation_codes ORDER BY created_at DESC, code LIMIT ?").bind(limit).all<CodeRecord>();
    return results.map(fromRecord);
  }

  async redeem(input: string, channelId: string, groupId: string, userId: string | undefined, now = new Date()) {
    const r = await this.db
      .prepare(
        `UPDATE activation_codes SET used_group = ?, used_by = ?, used_at = ?
         WHERE code = ? AND channel_id = ? AND used_at IS NULL AND (expires_at IS NULL OR expires_at > ?)
         RETURNING *`,
      )
      .bind(groupId, userId ?? null, now.toISOString(), normalizeCode(input), channelId, now.toISOString())
      .first<CodeRecord>();
    return r ? fromRecord(r) : undefined;
  }

  async revoke(code: string) {
    const res = await this.db.prepare("DELETE FROM activation_codes WHERE code = ? AND used_at IS NULL").bind(normalizeCode(code)).run();
    return res.meta.changes > 0;
  }
}

export class MemoryCodeRepo implements CodeRepo {
  codes: ActivationCode[] = [];

  async create(spec: NewCode) {
    const c = { ...spec, code: newCode(), createdAt: new Date().toISOString() };
    this.codes.push(c);
    return c;
  }

  async list() {
    return [...this.codes].reverse();
  }

  async redeem(input: string, channelId: string, groupId: string, userId: string | undefined, now = new Date()) {
    const c = this.codes.find((x) => x.code === normalizeCode(input));
    if (!c || c.channelId !== channelId || c.usedAt || (c.expiresAt && c.expiresAt <= now.toISOString())) return undefined;
    Object.assign(c, { usedGroup: groupId, usedBy: userId, usedAt: now.toISOString() });
    return c;
  }

  async revoke(code: string) {
    const i = this.codes.findIndex((x) => x.code === normalizeCode(code) && !x.usedAt);
    if (i < 0) return false;
    this.codes.splice(i, 1);
    return true;
  }
}
