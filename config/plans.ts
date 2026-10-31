import { LANG_CODES, type LangCode } from "./languages";

/**
 * Every plan is per person: one account per LINE member (per channel), bound to
 * any number of groups, which all draw on the account's monthly allowance.
 * Plans differ only in how much they allow (characters, AI requests) plus the
 * features that cost real model time (tone, engine choice, the assistant).
 */
export interface Plan {
  id: PlanId;
  name: string;
  /** NT$ per person per month. */
  price: number;
  /** Characters translatable per month across all the account's groups (Taipei calendar). 0 = unlimited. */
  monthlyChars: number;
  /** Languages a group on this plan may choose. */
  languages: LangCode[];
  /** Weekly task digest. */
  digest: boolean;
  /** "@bot" requests in plain words, understood by Claude. */
  ai: boolean;
  /** "@bot" requests per month across the account's groups; 0 with ai = unlimited. */
  aiRequests: number;
  /** Group admins may pick the translation engine and tone (AI translation). */
  engineChoice: boolean;
  /** Top-up characters can be bought on this plan (see TOP_UP). */
  topUp: boolean;
}

export type PlanId = "free" | "starter" | "advanced";

export const PLANS: Record<PlanId, Plan> = {
  free: {
    id: "free",
    name: "免費 Free",
    price: 0,
    monthlyChars: 30_000,
    languages: ["zh-TW", "en"],
    digest: false,
    ai: false,
    aiRequests: 0,
    engineChoice: false,
    topUp: false,
  },
  starter: {
    id: "starter",
    name: "入門 Starter",
    price: 149,
    monthlyChars: 300_000,
    languages: LANG_CODES,
    digest: true,
    ai: true,
    aiRequests: 100,
    engineChoice: true,
    topUp: false,
  },
  advanced: {
    id: "advanced",
    name: "進階 Advanced",
    price: 399,
    monthlyChars: 1_500_000,
    languages: LANG_CODES,
    digest: true,
    ai: true,
    aiRequests: 500,
    engineChoice: true,
    topUp: true,
  },
};

/** Higher is better; a code for a lower plan never downgrades an account still on a higher one. */
export const PLAN_RANK: Record<PlanId, number> = { free: 0, starter: 1, advanced: 2 };

/** Plan IDs from before the per-person plans, still in older rows. */
const LEGACY: Record<string, PlanId> = { pro: "advanced", duo: "starter" };

export const planIdOf = (plan: string | undefined): PlanId => {
  const id = LEGACY[plan ?? ""] ?? plan;
  return id && id in PLANS ? (id as PlanId) : "free";
};

/** Extra characters sold on top of the Advanced plan; they never expire. */
export const TOP_UP = { chars: 500_000, price: 99 };

/**
 * How many allowance characters one translated character costs, by engine,
 * relative to Claude Haiku. Google and DeepL bill about 18× Haiku per character;
 * Claude Opus about 15–40× depending on how long it thinks.
 */
export const ENGINE_WEIGHT: Record<string, number> = {
  google: 18,
  deepl: 18,
  "claude-haiku-5-5": 1,
  "claude-opus-5-5": 15,
};

/** The engine every group starts on, and the only one on plans without engine choice. */
export const DEFAULT_ENGINE = { engine: "claude", model: "claude-haiku-5-5" } as const;

/** Engines group admins can choose on plans with engineChoice. */
export const ENGINE_CHOICES = [
  { id: "claude-haiku-5-5", engine: "claude", model: "claude-haiku-5-5", label: "Claude Haiku（可調語氣，推薦）" },
  { id: "claude-opus-5-5", engine: "claude", model: "claude-opus-5-5", label: "Claude Opus（品質最好，額度 ×15）" },
] as const;

/** Weight for a group's translate settings: engine "claude" is keyed by its model. */
export function engineWeight(settings: Record<string, unknown>): number {
  const engine = String(settings.engine ?? DEFAULT_ENGINE.engine);
  const key = engine === "claude" ? String(settings.model ?? DEFAULT_ENGINE.model) : engine;
  return ENGINE_WEIGHT[key] ?? 1;
}

/**
 * Shown on the settings page under the plan. There is no payment gateway yet:
 * customers pay by transfer and a platform admin sets the plan in the admin page.
 */
export const UPGRADE_NOTE = "升級：請聯絡服務提供者，付款後由管理員開通。\nTo upgrade, contact your provider; the plan is switched on after payment.";

/**
 * The plan in force: a paid plan past its end date falls back to free.
 * A date-only `planUntil` ("2026-11-30") lasts to the end of that day in Taipei.
 */
export function effectivePlan(plan: string | undefined, planUntil: string | undefined, now = new Date()): Plan {
  const p = PLANS[planIdOf(plan)];
  if (p.id === "free" || !planUntil) return p;
  const end = /^\d{4}-\d{2}-\d{2}$/.test(planUntil) ? `${planUntil}T23:59:59.999+08:00` : planUntil;
  return new Date(end).getTime() < now.getTime() ? PLANS.free : p;
}

/**
 * What an account becomes when it redeems a plan: never a downgrade while a
 * better plan is still in force, and a renewal of the same plan never shortens
 * it (it keeps the later end date).
 */
export function mergeGrant(
  current: { plan: string; planUntil?: string } | undefined,
  plan: string,
  planUntil: string | undefined,
  now = new Date(),
): { plan: PlanId; planUntil?: string } {
  const want = planIdOf(plan);
  const have = current ? effectivePlan(current.plan, current.planUntil, now).id : "free";
  if (want === "free" || PLAN_RANK[have] > PLAN_RANK[want]) return { plan: current ? planIdOf(current.plan) : "free", planUntil: current?.planUntil };
  if (have === want && current && !current.planUntil) return { plan: want }; // already open-ended
  if (have === want && current?.planUntil && planUntil) return { plan: want, planUntil: current.planUntil > planUntil ? current.planUntil : planUntil };
  return { plan: want, planUntil };
}
