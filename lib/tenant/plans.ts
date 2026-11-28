/**
 * Plans and what they unlock (#45, #65). Brand tokens are on every plan;
 * anything beyond tokens is paid on the hosted service. A self-hosted install
 * has no gating at all: it only turns on when PAGEFIRST_EDITION=hosted.
 */

export const PLANS = ["free", "pro", "team", "enterprise"] as const;
export type Plan = (typeof PLANS)[number];

export const FEATURES = ["customCss", "templateOverrides", "scim", "domainLock", "themeGovernance", "customDomains"] as const;
export type Feature = (typeof FEATURES)[number];

const PAID: readonly Plan[] = ["pro", "team", "enterprise"];

const ENTERPRISE: readonly Plan[] = ["enterprise"];

const UNLOCKS: Record<Feature, readonly Plan[]> = {
  customCss: PAID,
  templateOverrides: PAID,
  scim: ENTERPRISE,
  domainLock: ENTERPRISE,
  themeGovernance: ENTERPRISE,
  customDomains: PAID,
};

const FEATURE_NAMES: Record<Feature, string> = {
  customCss: "Custom CSS",
  templateOverrides: "Template overrides",
  scim: "SCIM provisioning",
  domainLock: "Domain lock",
  themeGovernance: "Theme governance",
  customDomains: "Custom domains",
};

export function isPlan(value: unknown): value is Plan {
  return typeof value === "string" && (PLANS as readonly string[]).includes(value);
}

/** True on the hosted service, where features follow the organization's plan. */
export function gatingEnabled(): boolean {
  return process.env.PAGEFIRST_EDITION?.trim().toLowerCase() === "hosted";
}

/** Whether a plan includes a feature, ignoring the edition. */
export function planIncludes(plan: Plan, feature: Feature): boolean {
  return UNLOCKS[feature].includes(plan);
}

/** Whether a feature is available: always when self-hosted, by plan when hosted. */
export function featureAllowed(plan: Plan, feature: Feature): boolean {
  return !gatingEnabled() || planIncludes(plan, feature);
}

export class PlanError extends Error {
  readonly feature: Feature;
  readonly status = 402;
  constructor(feature: Feature) {
    super(`${FEATURE_NAMES[feature]} needs ${UNLOCKS[feature] === ENTERPRISE ? "the enterprise plan" : "a paid plan"}.`);
    this.name = "PlanError";
    this.feature = feature;
  }
}
