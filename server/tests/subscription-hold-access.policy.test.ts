import assert from "node:assert/strict";
import { test } from "node:test";
import {
  calculateSubscriptionAccessMode,
  decideSubscriptionCapability,
  type BusinessCapability,
  type SubscriptionAccessState,
} from "../src/modules/subscriptions/subscription-hold-access.policy";

const full: SubscriptionAccessState = {
  businessStatus: "ACTIVE",
  currentSubscriptionStatus: "ACTIVE",
  hasAuthorizedMembership: true,
};
const held: SubscriptionAccessState = {
  ...full,
  currentSubscriptionStatus: "PAST_DUE",
};

test("active paying subscription retains full access, held subscription becomes limited", () => {
  assert.equal(calculateSubscriptionAccessMode(full), "FULL");
  assert.equal(calculateSubscriptionAccessMode(held), "HOLD");
  assert.equal(calculateSubscriptionAccessMode({ ...full, currentSubscriptionStatus: "TRIALING" }), "FULL");
});

test("hold permits dashboard, profile, existing entries, archived reports and billing review", () => {
  const allowed: BusinessCapability[] = [
    "VIEW_DASHBOARD", "VIEW_PROFILE", "EDIT_PROFILE", "VIEW_PREVIOUS_ENTRIES",
    "VIEW_BILLING", "REQUEST_PAYMENT_REVIEW",
  ];
  for (const capability of allowed) {
    const decision = decideSubscriptionCapability(held, capability);
    assert.equal(decision.mode, "HOLD");
    assert.equal(decision.allowed, true, capability);
  }
});

test("hold disallows fresh financial entries, new invoices, report generation and deletion", () => {
  const blocked: BusinessCapability[] = [
    "CREATE_INCOME", "CREATE_EXPENSE", "CREATE_INVOICE", "GENERATE_REPORT",
    "CREATE_NEW_TRANSACTION", "DELETE_ENTRY", "MANAGE_USERS",
  ];
  for (const capability of blocked) {
    const decision = decideSubscriptionCapability(held, capability);
    assert.equal(decision.allowed, false, capability);
    assert.equal(decision.code, "SUBSCRIPTION_ON_HOLD");
  }
});

test("editing an old entry needs business ownership and proof it predates the hold", () => {
  assert.equal(decideSubscriptionCapability(held, "EDIT_PREVIOUS_ENTRY").allowed, false);
  assert.equal(decideSubscriptionCapability(held, "EDIT_PREVIOUS_ENTRY", {
    kind: "EXISTING_ENTRY", sameBusiness: true, createdBeforeHold: true,
  }).allowed, true);
  assert.equal(decideSubscriptionCapability(held, "EDIT_PREVIOUS_ENTRY", {
    kind: "EXISTING_ENTRY", sameBusiness: true, createdBeforeHold: false,
  }).allowed, false);
});

test("hold only allows view/download of immutable saved historical reports", () => {
  for (const capability of ["VIEW_SAVED_REPORT", "DOWNLOAD_SAVED_REPORT"] as const) {
    assert.equal(decideSubscriptionCapability(held, capability).allowed, false);
    assert.equal(decideSubscriptionCapability(held, capability, {
      kind: "SAVED_REPORT", sameBusiness: true,
      generatedBeforeHold: true, immutableSnapshot: true,
    }).allowed, true);
    assert.equal(decideSubscriptionCapability(held, capability, {
      kind: "SAVED_REPORT", sameBusiness: true,
      generatedBeforeHold: false, immutableSnapshot: true,
    }).allowed, false);
    assert.equal(decideSubscriptionCapability(held, capability, {
      kind: "SAVED_REPORT", sameBusiness: true,
      generatedBeforeHold: true, immutableSnapshot: false,
    }).allowed, false);
  }
});

test("administratively suspended businesses are not mistaken for a billing hold", () => {
  assert.equal(calculateSubscriptionAccessMode({
    ...held, businessStatus: "SUSPENDED",
  }), "LOCKED");
  assert.equal(decideSubscriptionCapability({
    ...held, businessStatus: "SUSPENDED",
  }, "EDIT_PROFILE").allowed, false);
});

test("unverified, missing and cancelled subscriptions cannot bypass the hold policy", () => {
  const locked: SubscriptionAccessState[] = [
    { ...full, hasAuthorizedMembership: false },
    { ...full, currentSubscriptionStatus: null },
    { ...full, businessStatus: "PENDING" },
    { ...full, currentSubscriptionStatus: "CANCELLED" },
    { ...full, currentSubscriptionStatus: "EXPIRED" },
    { ...full, currentSubscriptionStatus: "PENDING" },
  ];
  for (const state of locked) {
    assert.equal(calculateSubscriptionAccessMode(state), "LOCKED");
    assert.equal(decideSubscriptionCapability(state, "EDIT_PROFILE").allowed, false);
  }
});

test("reactivation restores full access only after trusted subscription status changes", () => {
  assert.equal(decideSubscriptionCapability(held, "CREATE_INCOME").allowed, false);
  assert.equal(decideSubscriptionCapability(full, "CREATE_INCOME").allowed, true);
  assert.equal(decideSubscriptionCapability(full, "GENERATE_REPORT").allowed, true);
});

test("even a fully active subscription cannot bypass ownership checks for historic resources", () => {
  assert.equal(decideSubscriptionCapability(full, "EDIT_PREVIOUS_ENTRY").allowed, false);
  assert.equal(decideSubscriptionCapability(full, "VIEW_SAVED_REPORT").allowed, false);
});
