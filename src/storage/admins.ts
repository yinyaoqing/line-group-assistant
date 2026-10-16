export interface Admin {
  groupId: string;
  /** The member's ID as the bot sees it (from webhook events and @-mentions). */
  lineUserId: string;
  /** Their LINE Login ID, once they have opened the settings page. */
  loginSub?: string;
  role: "owner" | "admin";
}

export type BindResult = "ok" | "missing" | "conflict";

/** Group admins, and the single-use nonces of settings links. */
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
}

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
}

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
}
