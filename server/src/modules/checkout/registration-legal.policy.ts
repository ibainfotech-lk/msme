/**
 * Registration legal-document acceptance. A Privacy Notice acknowledgment
 * is NOT consent to optional marketing or a substitute for lawful processing.
 * The version identifiers must match immutable published documents.
 * Keep registration production-disabled until legal review is complete.
 */
export const REGISTRATION_TERMS_VERSION = "2026-11-22-v1" as const;
export const REGISTRATION_PRIVACY_VERSION = "2026-11-22-v1" as const;

export interface RegistrationLegalAgreement {
  termsAccepted: boolean;
  privacyAcknowledged: boolean;
  termsVersion: string;
  privacyVersion: string;
}

export function hasValidRegistrationLegalAgreement(
  value: RegistrationLegalAgreement
): boolean {
  return value.termsAccepted === true &&
    value.privacyAcknowledged === true &&
    value.termsVersion === REGISTRATION_TERMS_VERSION &&
    value.privacyVersion === REGISTRATION_PRIVACY_VERSION;
}
