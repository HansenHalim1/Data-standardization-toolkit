export type PlanName = "free" | "starter" | "pro" | "business";

export type PlanFlags = {
  plan: PlanName;
  rowCap: number;
  fuzzyMatching: boolean;
  schedules: boolean;
  apiAccess: boolean;
  seats: number;
};

const PLAN_MATRIX: Record<PlanName, Omit<PlanFlags, "plan" | "seats">> = {
  free: {
    rowCap: 2_000,
    fuzzyMatching: false,
    schedules: false,
    apiAccess: false
  },
  starter: {
    rowCap: 10_000,
    fuzzyMatching: false,
    schedules: true,
    apiAccess: false
  },
  pro: {
    rowCap: 50_000,
    fuzzyMatching: true,
    schedules: true,
    apiAccess: true
  },
  business: {
    rowCap: 250_000,
    fuzzyMatching: true,
    schedules: true,
    apiAccess: true
  }
};

export function flagsForPlan(plan: string, seats = 1): PlanFlags {
  const normalized = (plan?.toLowerCase() as PlanName) ?? "free";
  const base = PLAN_MATRIX[normalized] ?? PLAN_MATRIX.free;
  return {
    plan: normalized in PLAN_MATRIX ? normalized : "free",
    seats: Math.max(1, seats),
    ...base
  };
}

export function assertFeature({
  flags,
  requireFuzzy
}: {
  flags: PlanFlags;
  requireFuzzy?: boolean;
}) {
  if (requireFuzzy && !flags.fuzzyMatching) {
    throw new Error("Fuzzy matching is not available for your plan.");
  }
}
