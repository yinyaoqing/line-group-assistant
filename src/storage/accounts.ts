import { mergeGrant } from "../../config/plans";

/**
 * Accounts: one per LINE member per channel, created (on the free plan) when
 * they first activate a group. Every group is bound to an account, takes its
 * plan and bills usage to it: the monthly allowance first, then top-up
 * characters (bonus), which never expire.
 */
export interface Account {
  accountId: string;
  channelId: string;
  userId: string;
  plan: string;
  planUntil?: string;
  bonusChars: number;
  createdAt?: string;
}

export const accountIdOf = (channelId: string, userId: string) => `${channelId}:${userId}`;

/** Usage meter key for an account, alongside group IDs in the usage table. */
export const accountUsageKey = (accountId: string) => `acct:${accountId}`;

export interface AccountRepo {
  get(accountId: string): Promise<Account | undefined>;
  /** The member's account, created on the free plan if they have none. */
  ensure(channelId: string, userId: string): Promise<Account>;
  /** Redeem a plan: create the account or upgrade/renew it (never downgrades or shortens, see mergeGrant). */
  grant(channelId: string, userId: string, plan: string, planUntil?: string): Promise<Account>;
  /** Add (or, negative, remove) top-up characters; the balance never goes below zero. */
  addBonus(accountId: string, chars: number): Promise<Account | undefined>;
  update(accountId: string, patch: Partial<Pick<Account, "plan" | "planUntil">>): Promise<Account | undefined>;
  list(): Promise<Account[]>;
}

interface AccountRecord {
  account_id: string;
  channel_id: string;
  user_id: string;
  plan: string;
  plan_until: string | null;
  bonus_chars: number;
  created_at: string;
}

const fromRecord = (r: AccountRecord): Account => ({
  accountId: r.account_id,
  channelId: r.channel_id,
  userId: r.user_id,
  plan: r.plan,
  planUntil: r.plan_until ?? undefined,
  bonusChars: r.bonus_chars,
  createdAt: r.created_at,
});

export class D1AccountRepo implements AccountRepo {
  constructor(private db: D1Database) {}

  async get(accountId: string) {
    const r = await this.db.prepare("SELECT * FROM accounts WHERE account_id = ?").bind(accountId).first<AccountRecord>();
    return r ? fromRecord(r) : undefined;
  }

  async ensure(channelId: string, userId: string) {
    const id = accountIdOf(channelId, userId);
    await this.db
      .prepare("INSERT INTO accounts (account_id, channel_id, user_id, plan) VALUES (?, ?, ?, 'free') ON CONFLICT (account_id) DO NOTHING")
      .bind(id, channelId, userId)
      .run();
    return (await this.get(id))!;
  }

  async grant(channelId: string, userId: string, plan: string, planUntil?: string) {
    const id = accountIdOf(channelId, userId);
    const next = mergeGrant(await this.get(id), plan, planUntil);
    await this.db
      .prepare(
        `INSERT INTO accounts (account_id, channel_id, user_id, plan, plan_until) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (account_id) DO UPDATE SET plan = excluded.plan, plan_until = excluded.plan_until`,
      )
      .bind(id, channelId, userId, next.plan, next.planUntil ?? null)
      .run();
    return (await this.get(id))!;
  }

  async addBonus(accountId: string, chars: number) {
    await this.db.prepare("UPDATE accounts SET bonus_chars = MAX(0, bonus_chars + ?) WHERE account_id = ?").bind(Math.trunc(chars), accountId).run();
    return this.get(accountId);
  }

  async update(accountId: string, patch: Partial<Pick<Account, "plan" | "planUntil">>) {
    if (patch.plan !== undefined) await this.db.prepare("UPDATE accounts SET plan = ? WHERE account_id = ?").bind(patch.plan, accountId).run();
    if (patch.planUntil !== undefined) await this.db.prepare("UPDATE accounts SET plan_until = ? WHERE account_id = ?").bind(patch.planUntil || null, accountId).run();
    return this.get(accountId);
  }

  async list() {
    const { results } = await this.db.prepare("SELECT * FROM accounts ORDER BY created_at DESC").all<AccountRecord>();
    return results.map(fromRecord);
  }
}

export class MemoryAccountRepo implements AccountRepo {
  accounts: Account[] = [];

  async get(accountId: string) {
    return this.accounts.find((a) => a.accountId === accountId);
  }

  async ensure(channelId: string, userId: string) {
    const id = accountIdOf(channelId, userId);
    const existing = await this.get(id);
    if (existing) return existing;
    const a: Account = { accountId: id, channelId, userId, plan: "free", bonusChars: 0 };
    this.accounts.push(a);
    return a;
  }

  async grant(channelId: string, userId: string, plan: string, planUntil?: string) {
    const a = await this.ensure(channelId, userId);
    const next = mergeGrant(a, plan, planUntil);
    return Object.assign(a, { plan: next.plan, planUntil: next.planUntil });
  }

  async addBonus(accountId: string, chars: number) {
    const a = await this.get(accountId);
    if (a) a.bonusChars = Math.max(0, a.bonusChars + Math.trunc(chars));
    return a;
  }

  async update(accountId: string, patch: Partial<Pick<Account, "plan" | "planUntil">>) {
    const a = await this.get(accountId);
    if (a) Object.assign(a, Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)));
    return a;
  }

  async list() {
    return [...this.accounts];
  }
}
