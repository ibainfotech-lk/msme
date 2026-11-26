import assert from "node:assert/strict";
import { test } from "node:test";
import {
  REGISTRATION_TERMS_VERSION,
  REGISTRATION_PRIVACY_VERSION,
  hasValidRegistrationLegalAgreement,
} from "../src/modules/checkout/registration-legal.policy";

const accepted = {
  termsAccepted: true,
  privacyAcknowledged: true,
  termsVersion: REGISTRATION_TERMS_VERSION,
  privacyVersion: REGISTRATION_PRIVACY_VERSION,
};

test("accepts the exact current legal documents", () => {
  assert.equal(hasValidRegistrationLegalAgreement(accepted), true);
});
test("does not accept either unchecked mandatory acknowledgment", () => {
  assert.equal(hasValidRegistrationLegalAgreement({ ...accepted, termsAccepted: false }), false);
  assert.equal(hasValidRegistrationLegalAgreement({ ...accepted, privacyAcknowledged: false }), false);
});
test("stale or fabricated document versions fail closed", () => {
  assert.equal(hasValidRegistrationLegalAgreement({ ...accepted, termsVersion: "old-version" }), false);
  assert.equal(hasValidRegistrationLegalAgreement({ ...accepted, privacyVersion: "old-version" }), false);
});
