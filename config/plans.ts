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
}

export type PlanId = "free" | "pro";

export const PLANS: Record<PlanId, Plan> = {
  free: { id: "free", name: "免費 Free", price: 0, monthlyChars: 50_000, languages: ["zh-TW", "en"], digest: false, ai: false },
  pro: { id: "pro", name: "專業版 Pro", price: 249, monthlyChars: 500_000, languages: LANG_CODES, digest: true, ai: true },
};

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
