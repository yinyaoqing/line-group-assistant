import { LANG_CODES, type LangCode } from "./languages";

export interface Plan {
  id: PlanId;
  name: string;
  /** NT$ per group per month; shown on the settings page. */
  price: number;
  /** Characters translatable per group per month (Taipei calendar). */
  monthlyChars: number;
  /** Languages a group on this plan may choose. */
  languages: LangCode[];
  /** Weekly task digest. */
  digest: boolean;
  /** "@bot" requests in plain words, understood by Claude. */
  ai: boolean;
  /**
   * Billed per person rather than per group: the member's account covers any
   * number of groups, which all draw on one monthly allowance plus top-ups.
   */
  perUser?: boolean;
  /** Group admins may pick the translation engine and tone (AI translation). */
  engineChoice?: boolean;
}

export type PlanId = "free" | "pro" | "duo";

export const PLANS: Record<PlanId, Plan> = {
  free: { id: "free", name: "免費 Free", price: 0, monthlyChars: 50_000, languages: ["zh-TW", "en"], digest: false, ai: false },
  pro: { id: "pro", name: "專業版 Pro", price: 249, monthlyChars: 500_000, languages: LANG_CODES, digest: true, ai: true, engineChoice: true },
  duo: {
    id: "duo",
    name: "雙人版 Duo",
    price: 149,
    monthlyChars: 300_000,
    languages: LANG_CODES,
    digest: false,
    ai: true,
    perUser: true,
    engineChoice: true,
  },
};

/** Extra characters sold on top of a per-user plan; they never expire. */
export const TOP_UP = { chars: 100_000, price: 49 };

/**
 * How many allowance characters one translated character costs, by engine.
 * Claude Opus costs roughly 37× Haiku per message, so its characters count
 * 15× to keep a Duo month within its price.
 */
export const ENGINE_WEIGHT: Record<string, number> = {
  google: 1,
  deepl: 1,
  "claude-haiku-5-5": 1,
  "claude-opus-5-5": 15,
};

/** Engines group admins can choose on plans with engineChoice. */
export const ENGINE_CHOICES = [
  { id: "claude-haiku-5-5", engine: "claude", model: "claude-haiku-5-5", label: "Claude Haiku（可調語氣，推薦）" },
  { id: "claude-opus-5-5", engine: "claude", model: "claude-opus-5-5", label: "Claude Opus（品質最好，額度 ×15）" },
  { id: "google", engine: "google", model: undefined, label: "Google 翻譯（不能調語氣）" },
] as const;

/** Weight for a group's translate settings: engine "claude" is keyed by its model. */
export function engineWeight(settings: Record<string, unknown>): number {
  const engine = String(settings.engine ?? "google");
  const key = engine === "claude" ? String(settings.model ?? "claude-haiku-5-5") : engine;
  return ENGINE_WEIGHT[key] ?? 1;
}

/**
 * Shown on the settings page under the plan. There is no payment gateway yet:
 * customers pay by transfer and a platform admin sets the plan in the admin page.
 */
export const UPGRADE_NOTE = "升級專業版：請聯絡服務提供者，付款後由管理員開通。\nTo upgrade, contact your provider; the plan is switched on after payment.";

/**
 * The plan in force: a paid plan past its end date falls back to free.
 * A date-only `planUntil` ("2026-11-30") lasts to the end of that day in Taipei.
 */
export function effectivePlan(plan: string | undefined, planUntil: string | undefined, now = new Date()): Plan {
  const p = PLANS[plan as PlanId] ?? PLANS.free;
  if (p.id === "free" || !planUntil) return p;
  const end = /^\d{4}-\d{2}-\d{2}$/.test(planUntil) ? `${planUntil}T23:59:59.999+08:00` : planUntil;
  return new Date(end).getTime() < now.getTime() ? PLANS.free : p;
}
