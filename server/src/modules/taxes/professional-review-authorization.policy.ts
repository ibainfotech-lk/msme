/**
 * F.17.4f — PURE prospective authorization policy.
 *
 * No route or service calls this policy. Input is an exclusively server-sourced
 * snapshot for future implementation; callers MUST independently verify all
 * DB facts transactionally. A positive policy outcome is NOT an authorization,
 * taxpayer verification, professional credential grant, or permission to write.
 */
export type ProfessionalReviewAction = "RECOMMEND" | "INDEPENDENT_APPROVE";
export type ReviewPolicyReason =
  | "POLICY_CONDITIONS_MET"
  | "FEATURE_DISABLED" | "INVALID_CONTEXT"
  | "TENANT_ACCESS_DENIED" | "SUBSCRIPTION_NOT_ELIGIBLE"
  | "REVIEW_CASE_INCOMPLETE" | "CONFLICT_OF_INTEREST"
  | "PROFESSIONAL_CREDENTIAL_NOT_VERIFIED"
  | "REVIEW_GRANT_NOT_VALID" | "RECOMMENDATION_NOT_VALID";

export interface ReviewPolicyResult {
  outcome: "DENY" | "POLICY_CONDITIONS_MET";
  reason: ReviewPolicyReason;
  /** Always false until a separately reviewed service and DB exist. */
  grantsAuthorization: false;
  taxpayerVerified: false;
  taxCalculationEnabled: false;
  taxableIncomeLkr: null;
  taxPayableLkr: null;
  paymentDueLkr: null;
}

export interface ReviewGrantSnapshot {
  actorUserId: string;
  businessId: string;
  assessmentYearStart: number;
  action: ProfessionalReviewAction;
  issuedByUserId: string;
  independentlyProvisioned: boolean;
  validFromEpochMs: number;
  expiresAtEpochMs: number;
  revokedAtEpochMs: number | null;
}
export interface ReviewerCredentialSnapshot {
  userId: string;
  professionallyVerified: boolean;
  independentVerificationRecorded: boolean;
  scopeIncludesSriLankanTax: boolean;
  expiresAtEpochMs: number;
  revokedAtEpochMs: number | null;
}
export interface ReviewCaseSnapshot {
  businessId: string;
  assessmentYearStart: number;
  draftRevision: number;
  declarantUserId: string;
  beneficialOwnerUserIds: string[];
  evidenceSetSha256: string;
  legalSourcesSha256: string;
}
export interface RecommendationSnapshot {
  businessId: string;
  assessmentYearStart: number;
  draftRevision: number;
  reviewerUserId: string;
  evidenceSetSha256: string;
  legalSourcesSha256: string;
  status: "RECOMMEND_VERIFIED" | "NEEDS_INFORMATION" | "REJECTED";
}
export interface ReviewPolicyFacts {
  environment: "development" | "production" | "test";
  featureEnabled: boolean;
  /** Supplied by the server, NEVER from client headers or request body. */
  nowEpochMs: number;
  authenticatedUserId: string;
  actorUserId: string;
  action: ProfessionalReviewAction;
  businessId: string;
  assessmentYearStart: number;
  business: { id: string; status: string } | null;
  subscription: {
    businessId: string;
    status: string;
    startsAtEpochMs: number;
    endsAtEpochMs: number;
    heldAtEpochMs: number | null;
  } | null;
  membership: {
    businessId: string;
    userId: string;
    status: string;
  } | null;
  credential: ReviewerCredentialSnapshot | null;
  grant: ReviewGrantSnapshot | null;
  reviewCase: ReviewCaseSnapshot | null;
  recommendation: RecommendationSnapshot | null;
}

const sha256 = /^[0-9a-f]{64}$/i;
function isUserId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
function epoch(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function deny(reason: Exclude<ReviewPolicyReason,"POLICY_CONDITIONS_MET">): ReviewPolicyResult {
  return {
    outcome:"DENY",reason,grantsAuthorization:false,taxpayerVerified:false,
    taxCalculationEnabled:false,taxableIncomeLkr:null,taxPayableLkr:null,
    paymentDueLkr:null,
  };
}
const prospectiveOnly:ReviewPolicyResult={
  outcome:"POLICY_CONDITIONS_MET",reason:"POLICY_CONDITIONS_MET",
  grantsAuthorization:false,taxpayerVerified:false,
  taxCalculationEnabled:false,taxableIncomeLkr:null,taxPayableLkr:null,
  paymentDueLkr:null,
};

/**
 * Evaluates minimum necessary conditions using future *server-trusted* facts.
 * Does NOT check live DB, credential issuers or legal reviewer qualification.
 * Do not expose its result as a client-controllable authorization decision.
 */
export function evaluateProfessionalReviewPolicy(
  facts: Partial<ReviewPolicyFacts> | null | undefined
): ReviewPolicyResult {
  if (!facts || facts.environment !== "development" || facts.featureEnabled !== true) {
    return deny("FEATURE_DISABLED");
  }
  const {
    nowEpochMs: now,authenticatedUserId,actorUserId,action,
    businessId,assessmentYearStart,business,subscription,membership,
    credential,grant,reviewCase,recommendation,
  } = facts;
  if (!epoch(now) || !isUserId(authenticatedUserId) ||
      !isUserId(actorUserId) || authenticatedUserId !== actorUserId ||
      !isUserId(businessId) || !Number.isSafeInteger(assessmentYearStart) ||
      (assessmentYearStart as number) < 2025 ||
      (action !== "RECOMMEND" && action !== "INDEPENDENT_APPROVE")) {
    return deny("INVALID_CONTEXT");
  }
  if (!business || business.id !== businessId || business.status !== "ACTIVE" ||
      !membership || membership.businessId !== businessId ||
      membership.userId !== actorUserId || membership.status !== "ACTIVE") {
    return deny("TENANT_ACCESS_DENIED");
  }
  if (!subscription || subscription.businessId !== businessId ||
      !["ACTIVE","TRIALING"].includes(subscription.status) ||
      !epoch(subscription.startsAtEpochMs) || !epoch(subscription.endsAtEpochMs) ||
      now < subscription.startsAtEpochMs || now >= subscription.endsAtEpochMs ||
      subscription.heldAtEpochMs !== null) {
    return deny("SUBSCRIPTION_NOT_ELIGIBLE");
  }
  if (!reviewCase || reviewCase.businessId !== businessId ||
      reviewCase.assessmentYearStart !== assessmentYearStart ||
      !Number.isSafeInteger(reviewCase.draftRevision) ||
      reviewCase.draftRevision < 1 ||
      !isUserId(reviewCase.declarantUserId) ||
      !Array.isArray(reviewCase.beneficialOwnerUserIds) ||
      reviewCase.beneficialOwnerUserIds.length === 0 ||
      !reviewCase.beneficialOwnerUserIds.every(isUserId) ||
      typeof reviewCase.evidenceSetSha256 !== "string" ||
      !sha256.test(reviewCase.evidenceSetSha256) ||
      typeof reviewCase.legalSourcesSha256 !== "string" ||
      !sha256.test(reviewCase.legalSourcesSha256)) {
    return deny("REVIEW_CASE_INCOMPLETE");
  }
  if (actorUserId === reviewCase.declarantUserId ||
      reviewCase.beneficialOwnerUserIds.includes(actorUserId)) {
    return deny("CONFLICT_OF_INTEREST");
  }
  if (!credential || credential.userId !== actorUserId ||
      credential.professionallyVerified !== true ||
      credential.independentVerificationRecorded !== true ||
      credential.scopeIncludesSriLankanTax !== true ||
      !epoch(credential.expiresAtEpochMs) || now >= credential.expiresAtEpochMs ||
      credential.revokedAtEpochMs !== null) {
    return deny("PROFESSIONAL_CREDENTIAL_NOT_VERIFIED");
  }
  if (!grant || grant.actorUserId !== actorUserId ||
      grant.businessId !== businessId ||
      grant.assessmentYearStart !== assessmentYearStart ||
      grant.action !== action || grant.independentlyProvisioned !== true ||
      !isUserId(grant.issuedByUserId) || grant.issuedByUserId === actorUserId ||
      grant.issuedByUserId === reviewCase.declarantUserId ||
      reviewCase.beneficialOwnerUserIds.includes(grant.issuedByUserId) ||
      !epoch(grant.validFromEpochMs) || !epoch(grant.expiresAtEpochMs) ||
      now < grant.validFromEpochMs || now >= grant.expiresAtEpochMs ||
      grant.revokedAtEpochMs !== null) {
    return deny("REVIEW_GRANT_NOT_VALID");
  }
  if (action === "INDEPENDENT_APPROVE") {
    if (!recommendation || recommendation.status !== "RECOMMEND_VERIFIED" ||
        recommendation.businessId !== businessId ||
        recommendation.assessmentYearStart !== assessmentYearStart ||
        recommendation.draftRevision !== reviewCase.draftRevision ||
        recommendation.evidenceSetSha256 !== reviewCase.evidenceSetSha256 ||
        recommendation.legalSourcesSha256 !== reviewCase.legalSourcesSha256 ||
        !isUserId(recommendation.reviewerUserId)) {
      return deny("RECOMMENDATION_NOT_VALID");
    }
    if (recommendation.reviewerUserId === actorUserId ||
        recommendation.reviewerUserId === reviewCase.declarantUserId ||
        reviewCase.beneficialOwnerUserIds.includes(recommendation.reviewerUserId)) {
      return deny("CONFLICT_OF_INTEREST");
    }
  }
  // Passing the pure policy does not create a reviewer grant or decision.
  return { ...prospectiveOnly };
}
