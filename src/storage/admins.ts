export interface Admin {
  groupId: string;
  /** The member's ID as the bot sees it (from webhook events and @-mentions). */
  lineUserId: string;
  /** Their LINE Login ID, once they have opened the settings page. */
  loginSub?: string;
  role: "owner" | "admin";
}

export type BindResult = "ok" | "missing" | "conflict";

/**
 * A LINE Login account that opened an admin's settings link but cannot be
 * proved to be that admin (the official account lives in another provider, so
 * the two user IDs differ). It waits until the admin sends /confirm <code>.
 */
export interface PendingBind {
  groupId: string;
  lineUserId: string;
  loginSub: string;
  loginName: string;
  code: string;
  expiresAt: string;
}

/** Group admins, the single-use nonces of settings links, and binds awaiting /confirm. */
export interface AdminRepo {
  list(groupId: string): Promise<Admin[]>;
  get(groupId: string, lineUserId: string): Promise<Admin | undefined>;
  add(groupId: string, lineUserId: string, role: Admin["role"]): Promise<void>;
  remove(groupId: string, lineUserId: string): Promise<void>;
  /**
   * Tie an admin's chat identity to the LINE Login account that opened their
   * /settings link. "conflict" if it is already tied to a different account.
   */
  bindLogin(groupId: string, lineUserId: string, loginSub: string): Promise<BindResult>;
  /** Groups the signed-in account administers. */
  groupsForLogin(loginSub: string): Promise<Admin[]>;
  /** True the first time a nonce is seen, false after. */
  consumeNonce(nonce: string): Promise<boolean>;
  /**
   * Park a login account until the admin confirms it in the group; returns the
   * code to type (the same one while an unexpired request for this pair exists).
   */
  requestBind(groupId: string, lineUserId: string, loginSub: string, loginName: string, now: Date, ttlMs: number): Promise<string>;
  /** Remove and return the pending bind with this code, if it is this admin's and still valid. */
  takeBind(groupId: string, lineUserId: string, code: string, now: Date): Promise<PendingBind | undefined>;
}

/** Six digits: easy to type in a chat; the webhook's user ID, not the code, is what proves identity. */
const newBindCode = () => String(crypto.getRandomValues(new Uint32Array(1))[0]! % 1_000_000).padStart(6, "0");

interface AdminRecord {
  group_id: string;
  line_user_id: string;
  login_sub: string | null;
  role: string;
}

const fromRecord = (r: AdminRecord): Admin => ({
  groupId: r.group_id,
  lineUserId: r.line_user_id,
  loginSub: r.login_sub ?? undefined,
  role: r.role === "owner" ? "owner" : "admin",
});

export class D1AdminRepo implements AdminRepo {
  constructor(private db: D1Database) {}

  async list(groupId: string) {
    const { results } = await this.db
      .prepare("SELECT * FROM admins WHERE group_id = ? ORDER BY role DESC, created_at")
      .bind(groupId)
      .all<AdminRecord>();
    return results.map(fromRecord);
  }

  async get(groupId: string, lineUserId: string) {
    const r = await this.db
      .prepare("SELECT * FROM admins WHERE group_id = ? AND line_user_id = ?")
      .bind(groupId, lineUserId)
      .first<AdminRecord>();
    return r ? fromRecord(r) : undefined;
  }

  async add(groupId: string, lineUserId: string, role: Admin["role"]) {
    await this.db
      .prepare("INSERT INTO admins (group_id, line_user_id, role) VALUES (?, ?, ?) ON CONFLICT DO NOTHING")
      .bind(groupId, lineUserId, role)
      .run();
  }

  async remove(groupId: string, lineUserId: string) {
    await this.db.prepare("DELETE FROM admins WHERE group_id = ? AND line_user_id = ?").bind(groupId, lineUserId).run();
  }

  async bindLogin(groupId: string, lineUserId: string, loginSub: string): Promise<BindResult> {
    // Only fills an empty login_sub, so a link can never move an admin to another account.
    const res = await this.db
      .prepare("UPDATE admins SET login_sub = ? WHERE group_id = ? AND line_user_id = ? AND (login_sub IS NULL OR login_sub = ?)")
      .bind(loginSub, groupId, lineUserId, loginSub)
      .run();
    if (res.meta.changes > 0) return "ok";
    return (await this.get(groupId, lineUserId)) ? "conflict" : "missing";
  }

  async groupsForLogin(loginSub: string) {
    const { results } = await this.db.prepare("SELECT * FROM admins WHERE login_sub = ?").bind(loginSub).all<AdminRecord>();
    return results.map(fromRecord);
  }

  async consumeNonce(nonce: string) {
    const res = await this.db.prepare("INSERT INTO used_nonces (nonce) VALUES (?) ON CONFLICT DO NOTHING").bind(nonce).run();
    return res.meta.changes > 0;
  }

  async requestBind(groupId: string, lineUserId: string, loginSub: string, loginName: string, now: Date, ttlMs: number) {
    await this.db.prepare("DELETE FROM pending_binds WHERE expires_at < ?").bind(now.toISOString()).run();
    const existing = await this.db
      .prepare("SELECT code FROM pending_binds WHERE group_id = ? AND line_user_id = ? AND login_sub = ?")
      .bind(groupId, lineUserId, loginSub)
      .first<{ code: string }>();
    if (existing) return existing.code;
    const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
    // A code collision just means trying another one.
    for (;;) {
      const code = newBindCode();
      const res = await this.db
        .prepare("INSERT INTO pending_binds (code, group_id, line_user_id, login_sub, login_name, expires_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING")
        .bind(code, groupId, lineUserId, loginSub, loginName, expiresAt)
        .run();
      if (res.meta.changes > 0) return code;
    }
  }

  async takeBind(groupId: string, lineUserId: string, code: string, now: Date) {
    const r = await this.db
      .prepare("DELETE FROM pending_binds WHERE code = ? AND group_id = ? AND line_user_id = ? AND expires_at >= ? RETURNING *")
      .bind(code, groupId, lineUserId, now.toISOString())
      .first<PendingRecord>();
    return r ? pendingFromRecord(r) : undefined;
  }
}

interface PendingRecord {
  code: string;
  group_id: string;
  line_user_id: string;
  login_sub: string;
  login_name: string;
  expires_at: string;
}

const pendingFromRecord = (r: PendingRecord): PendingBind => ({
  code: r.code,
  groupId: r.group_id,
  lineUserId: r.line_user_id,
  loginSub: r.login_sub,
  loginName: r.login_name,
  expiresAt: r.expires_at,
});

export class MemoryAdminRepo implements AdminRepo {
  admins: Admin[] = [];
  private nonces = new Set<string>();

  async list(groupId: string) {
    return this.admins.filter((a) => a.groupId === groupId);
  }

  async get(groupId: string, lineUserId: string) {
    return this.admins.find((a) => a.groupId === groupId && a.lineUserId === lineUserId);
  }

  async add(groupId: string, lineUserId: string, role: Admin["role"]) {
    if (!(await this.get(groupId, lineUserId))) this.admins.push({ groupId, lineUserId, role });
  }

  async remove(groupId: string, lineUserId: string) {
    this.admins = this.admins.filter((a) => !(a.groupId === groupId && a.lineUserId === lineUserId));
  }

  async bindLogin(groupId: string, lineUserId: string, loginSub: string): Promise<BindResult> {
    const a = await this.get(groupId, lineUserId);
    if (!a) return "missing";
    if (a.loginSub && a.loginSub !== loginSub) return "conflict";
    a.loginSub = loginSub;
    return "ok";
  }

  async groupsForLogin(loginSub: string) {
    return this.admins.filter((a) => a.loginSub === loginSub);
  }

  async consumeNonce(nonce: string) {
    if (this.nonces.has(nonce)) return false;
    this.nonces.add(nonce);
    return true;
  }

  private pending: PendingBind[] = [];

  async requestBind(groupId: string, lineUserId: string, loginSub: string, loginName: string, now: Date, ttlMs: number) {
    this.pending = this.pending.filter((p) => p.expiresAt >= now.toISOString());
    const existing = this.pending.find((p) => p.groupId === groupId && p.lineUserId === lineUserId && p.loginSub === loginSub);
    if (existing) return existing.code;
    const code = newBindCode();
    this.pending.push({ code, groupId, lineUserId, loginSub, loginName, expiresAt: new Date(now.getTime() + ttlMs).toISOString() });
    return code;
  }

  async takeBind(groupId: string, lineUserId: string, code: string, now: Date) {
    const hit = this.pending.find((p) => p.code === code && p.groupId === groupId && p.lineUserId === lineUserId && p.expiresAt >= now.toISOString());
    if (hit) this.pending = this.pending.filter((p) => p !== hit);
    return hit;
  }
}
