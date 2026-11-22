/**
 * F.16.5.4c — subscription hold feature access, policy only.
 * Does not place/release a hold, initiate payments, generate records or reports.
 *
 * IMPORTANT: PAST_DUE is assigned only after due-date/grace-period,
 * verified-payment and disputed-payment checks by a future reviewed workflow.
 * The presence of an unpaid calendar month alone does not authorize a hold.
 */
export type BusinessState = "PENDING" | "ACTIVE" | "SUSPENDED" | "CLOSED";
export type SubscriptionState =
  | "PENDING" | "TRIALING" | "ACTIVE" | "PAST_DUE" | "EXPIRED" | "CANCELLED";
export type AccessMode = "FULL" | "HOLD" | "LOCKED";

export type BusinessCapability =
  | "VIEW_DASHBOARD"
  | "VIEW_PROFILE"
  | "EDIT_PROFILE"
  | "VIEW_PREVIOUS_ENTRIES"
  | "EDIT_PREVIOUS_ENTRY"
  | "VIEW_SAVED_REPORT"
  | "DOWNLOAD_SAVED_REPORT"
  | "VIEW_BILLING"
  | "REQUEST_PAYMENT_REVIEW"
  | "CREATE_INCOME"
  | "CREATE_EXPENSE"
  | "CREATE_INVOICE"
  | "GENERATE_REPORT"
  | "DELETE_ENTRY"
  | "CREATE_NEW_TRANSACTION"
  | "MANAGE_USERS";

export interface SubscriptionAccessState {
  businessStatus: BusinessState;
  currentSubscriptionStatus: SubscriptionState | null;
  hasAuthorizedMembership: boolean;
}

/**
 * A target must have been loaded and verified by a future business-scoped
 * repository. Never accept user-supplied booleans as proof of ownership.
 *
 * For historical edits, the repository must also verify that the row
 * existed BEFORE the hold started and record the changes in an audit trail.
 * For saved reports, the repository must return an immutable snapshot
 * generated before the hold; live recomputation is forbidden.
 */
export type VerifiedResource =
  | { kind: "EXISTING_ENTRY"; sameBusiness: true; createdBeforeHold: true }
  | { kind: "SAVED_REPORT"; sameBusiness: true; generatedBeforeHold: true; immutableSnapshot: true };

export interface FeatureAccessDecision {
  mode: AccessMode;
  allowed: boolean;
  code: "ALLOWED" | "SUBSCRIPTION_ON_HOLD" | "SUBSCRIPTION_ACCESS_LOCKED" | "RESOURCE_PROOF_REQUIRED";
}

const fullCapabilities: ReadonlySet<BusinessCapability> = new Set([
  "VIEW_DASHBOARD", "VIEW_PROFILE", "EDIT_PROFILE", "VIEW_PREVIOUS_ENTRIES",
  "EDIT_PREVIOUS_ENTRY", "VIEW_SAVED_REPORT", "DOWNLOAD_SAVED_REPORT",
  "VIEW_BILLING", "REQUEST_PAYMENT_REVIEW", "CREATE_INCOME", "CREATE_EXPENSE",
  "CREATE_INVOICE", "GENERATE_REPORT", "DELETE_ENTRY",
  "CREATE_NEW_TRANSACTION", "MANAGE_USERS",
]);
const onHoldCapabilities: ReadonlySet<BusinessCapability> = new Set([
  "VIEW_DASHBOARD", "VIEW_PROFILE", "EDIT_PROFILE", "VIEW_PREVIOUS_ENTRIES",
  "EDIT_PREVIOUS_ENTRY", "VIEW_SAVED_REPORT", "DOWNLOAD_SAVED_REPORT",
  "VIEW_BILLING", "REQUEST_PAYMENT_REVIEW",
]);

export function calculateSubscriptionAccessMode(state: SubscriptionAccessState): AccessMode {
  if (!state.hasAuthorizedMembership) return "LOCKED";

  // PAST_DUE is a review-approved hold; it does not revoke the user account.
  if ((state.businessStatus === "ACTIVE" || state.businessStatus === "SUSPENDED") &&
      state.currentSubscriptionStatus === "PAST_DUE") return "HOLD";

  if (state.businessStatus === "ACTIVE" &&
      (state.currentSubscriptionStatus === "ACTIVE" ||
       state.currentSubscriptionStatus === "TRIALING")) return "FULL";

  // Never infer FULL access from a missing/unknown subscription.
  return "LOCKED";
}

export function decideSubscriptionCapability(
  state: SubscriptionAccessState,
  capability: BusinessCapability,
  resource?: VerifiedResource
): FeatureAccessDecision {
  const mode = calculateSubscriptionAccessMode(state);
  const rejected = (code: FeatureAccessDecision["code"]): FeatureAccessDecision =>
    ({ mode, allowed: false, code });

  if (mode === "LOCKED") return rejected("SUBSCRIPTION_ACCESS_LOCKED");
  const permitted = (mode === "FULL" ? fullCapabilities : onHoldCapabilities).has(capability);
  if (!permitted) return rejected("SUBSCRIPTION_ON_HOLD");

  if (capability === "EDIT_PREVIOUS_ENTRY") {
    if (resource?.kind !== "EXISTING_ENTRY" ||
        resource.sameBusiness !== true ||
        (mode === "HOLD" && resource.createdBeforeHold !== true)) {
      return rejected("RESOURCE_PROOF_REQUIRED");
    }
  }

  if (capability === "VIEW_SAVED_REPORT" ||
      capability === "DOWNLOAD_SAVED_REPORT") {
    if (resource?.kind !== "SAVED_REPORT" ||
        resource.sameBusiness !== true ||
        resource.immutableSnapshot !== true ||
        (mode === "HOLD" && resource.generatedBeforeHold !== true)) {
      return rejected("RESOURCE_PROOF_REQUIRED");
    }
  }

  return { mode, allowed: true, code: "ALLOWED" };
}
