import { randomUUID } from "node:crypto";
import type { PoolConnection, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import pool from "../../config/database";
import { findCheckoutBusinessForUpdate } from "../checkout/checkout.repository";

/**
 * F.16.5.4i DEV ONLY — profile contact information while on reviewed hold.
 * Does NOT edit legal business name, registration type, OTP phone, verified
 * email, identity proof, business/subscription status, finance or entitlements.
 * Both personal name/language and optional business contact details are
 * updated with one explicit audit revision in a single DB transaction.
 */
export class HeldProfileError extends Error {
  constructor(public readonly code: string, public readonly statusCode = 403) {
    super(code);
    this.name = "HeldProfileError";
  }
}

export type ProfileLanguage = "en" | "ta" | "si";
export interface HeldProfileRef {
  businessId: string;
  userId: string;
}
export interface HeldProfileDetails {
  fullName: string;
  preferredLanguage: ProfileLanguage;
  displayName: string;
  contactEmail: string;
  address: string;
}
export interface HeldProfileSnapshot {
  businessId: string;
  businessLegalName: string;
  personalPhone: string;
  registrationEmail: string | null;
  mode: "HOLD";
  version: number;
  profile: HeldProfileDetails;
}
export interface HeldProfileUpdate extends HeldProfileRef, HeldProfileDetails {
  expectedVersion: number;
}
export interface HeldProfileUpdated {
  version: number;
  auditId: string;
  mode: "HOLD";
  financeModified: false;
}

interface SubscriptionRow extends RowDataPacket {
  status: string;
  held_at: Date | null;
}
interface UserRow extends RowDataPacket {
  full_name: string | null;
  preferred_language: ProfileLanguage;
  phone: string;
  email: string | null;
}
interface ContactRow extends RowDataPacket {
  version: number;
  display_name: string;
  contact_email: string;
  address: string;
}
interface PermissionRow extends RowDataPacket { allowed: number }
type ConnectionFactory = () => Promise<PoolConnection>;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const email = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function checkRef(input: HeldProfileRef): void {
  if (!uuid.test(input.businessId) || !uuid.test(input.userId)) {
    throw new HeldProfileError("INVALID_PROFILE_REFERENCE", 400);
  }
}

function validateDetails(input: HeldProfileUpdate): HeldProfileDetails {
  const fullName = typeof input.fullName === "string" ? input.fullName.trim() : "";
  const displayName = typeof input.displayName === "string" ? input.displayName.trim() : "";
  const contactEmail = typeof input.contactEmail === "string"
    ? input.contactEmail.trim().toLowerCase() : "";
  const address = typeof input.address === "string" ? input.address.trim() : "";
  if (!Number.isSafeInteger(input.expectedVersion) ||
      input.expectedVersion < 0 || input.expectedVersion >= 4294967295 ||
      fullName.length < 2 || fullName.length > 150 ||
      displayName.length < 2 || displayName.length > 150 ||
      !["en", "ta", "si"].includes(input.preferredLanguage) ||
      contactEmail.length > 191 || (contactEmail !== "" && !email.test(contactEmail)) ||
      address.length > 350 || /[<>]/.test(fullName + displayName + address)) {
    throw new HeldProfileError("INVALID_PROFILE_DETAILS", 400);
  }
  return { fullName, preferredLanguage: input.preferredLanguage, displayName, contactEmail, address };
}

async function withHeldProfile<T>(
  ref: HeldProfileRef,
  work: (connection: PoolConnection, state: {
    businessName: string; user: UserRow; contact: ContactRow | null;
  }) => Promise<T>,
  getConnection: ConnectionFactory
): Promise<T> {
  if (process.env.NODE_ENV !== "development" ||
      process.env.NOTETO_HELD_PROFILE_EDIT_ENABLED !== "true") {
    throw new HeldProfileError("HELD_PROFILE_DISABLED");
  }
  checkRef(ref);
  const connection = await getConnection();
  let started = false;
  try {
    await connection.beginTransaction();
    started = true;
    const business = await findCheckoutBusinessForUpdate(connection, ref.businessId);
    if (!business || business.status !== "ACTIVE") {
      throw new HeldProfileError("BUSINESS_ACCESS_DENIED");
    }
    const [subscriptions] = await connection.execute<SubscriptionRow[]>(
      [
        "SELECT bs.status, bs.held_at FROM businesses b",
        "JOIN business_subscriptions bs ON bs.id = b.current_subscription_id",
        "AND bs.business_id = b.id WHERE b.id = ? FOR UPDATE",
      ].join(" "),
      [ref.businessId]
    );
    const held = subscriptions[0];
    if (!held || held.status !== "PAST_DUE" ||
        !(held.held_at instanceof Date) || !Number.isFinite(held.held_at.getTime()) ||
        held.held_at.getTime() > Date.now()) {
      throw new HeldProfileError("REVIEWED_HOLD_REQUIRED");
    }
    const [permissions] = await connection.execute<PermissionRow[]>(
      [
        "SELECT 1 AS allowed FROM business_memberships bm",
        "JOIN users u ON u.id = bm.user_id AND u.status = 'ACTIVE'",
        "JOIN roles r ON r.id = bm.role_id AND r.business_id = bm.business_id",
        "JOIN role_permissions rp ON rp.role_id = r.id",
        "JOIN permissions p ON p.id = rp.permission_id",
        "WHERE bm.business_id = ? AND bm.user_id = ? AND bm.status = 'ACTIVE'",
        "AND p.`key` = 'business.manage' LIMIT 1",
      ].join(" "),
      [ref.businessId, ref.userId]
    );
    if (permissions.length !== 1) throw new HeldProfileError("PROFILE_PERMISSION_DENIED");
    const [users] = await connection.execute<UserRow[]>(
      "SELECT full_name, preferred_language, phone, email FROM users WHERE id = ? AND status = 'ACTIVE' FOR UPDATE",
      [ref.userId]
    );
    if (users.length !== 1) throw new HeldProfileError("PROFILE_USER_NOT_FOUND");
    const [contacts] = await connection.execute<ContactRow[]>(
      "SELECT version, display_name, contact_email, address FROM business_profile_details WHERE business_id = ? FOR UPDATE",
      [ref.businessId]
    );
    // Business name is read separately only after membership and permissions.
    const [businessRows] = await connection.execute<(RowDataPacket & { name: string })[]>(
      "SELECT name FROM businesses WHERE id = ?",
      [ref.businessId]
    );
    if (businessRows.length !== 1) throw new HeldProfileError("BUSINESS_ACCESS_DENIED");
    const output = await work(connection, {
      businessName: businessRows[0].name, user: users[0], contact: contacts[0] ?? null,
    });
    await connection.commit();
    started = false;
    return output;
  } catch (error) {
    if (started) await connection.rollback();
    throw error;
  } finally { connection.release(); }
}

export function getHeldProfile(
  ref: HeldProfileRef,
  getConnection: ConnectionFactory = () => pool.getConnection()
): Promise<HeldProfileSnapshot> {
  return withHeldProfile(ref, async (_connection, state) => ({
    businessId: ref.businessId,
    businessLegalName: state.businessName,
    personalPhone: state.user.phone,
    registrationEmail: state.user.email,
    mode: "HOLD",
    version: state.contact?.version ?? 0,
    profile: {
      fullName: state.user.full_name ?? "",
      preferredLanguage: state.user.preferred_language,
      displayName: state.contact?.display_name ?? "",
      contactEmail: state.contact?.contact_email ?? "",
      address: state.contact?.address ?? "",
    },
  }), getConnection);
}

export function updateHeldProfile(
  input: HeldProfileUpdate,
  getConnection: ConnectionFactory = () => pool.getConnection()
): Promise<HeldProfileUpdated> {
  if (process.env.NODE_ENV !== "development" ||
      process.env.NOTETO_HELD_PROFILE_EDIT_ENABLED !== "true") {
    return Promise.reject(new HeldProfileError("HELD_PROFILE_DISABLED"));
  }
  checkRef(input);
  const next = validateDetails(input);
  return withHeldProfile(input, async (connection, state) => {
    const previousVersion = state.contact?.version ?? 0;
    if (previousVersion !== input.expectedVersion) {
      throw new HeldProfileError("PROFILE_VERSION_CONFLICT", 409);
    }
    const before: HeldProfileDetails = {
      fullName: state.user.full_name ?? "",
      preferredLanguage: state.user.preferred_language,
      displayName: state.contact?.display_name ?? "",
      contactEmail: state.contact?.contact_email ?? "",
      address: state.contact?.address ?? "",
    };
    if (JSON.stringify(before) === JSON.stringify(next)) {
      throw new HeldProfileError("NO_PROFILE_CHANGES", 400);
    }
    const newVersion = previousVersion + 1;
    if (state.contact) {
      const [result] = await connection.execute<ResultSetHeader>(
        [
          "UPDATE business_profile_details SET display_name = ?, contact_email = ?,",
          "address = ?, version = ?, updated_at = UTC_TIMESTAMP(3)",
          "WHERE business_id = ? AND version = ?",
        ].join(" "),
        [next.displayName, next.contactEmail, next.address, newVersion,
         input.businessId, previousVersion]
      );
      if (result.affectedRows !== 1) throw new HeldProfileError("PROFILE_VERSION_CONFLICT", 409);
    } else {
      await connection.execute(
        [
          "INSERT INTO business_profile_details",
          "(business_id, display_name, contact_email, address, version, updated_at)",
          "VALUES (?, ?, ?, ?, 1, UTC_TIMESTAMP(3))",
        ].join(" "),
        [input.businessId, next.displayName, next.contactEmail, next.address]
      );
    }
    await connection.execute(
      [
        "UPDATE users SET full_name = ?, preferred_language = ?,",
        "updated_at = UTC_TIMESTAMP(3) WHERE id = ? AND status = 'ACTIVE'",
      ].join(" "),
      [next.fullName, next.preferredLanguage, input.userId]
    );
    const auditId = randomUUID();
    await connection.execute(
      [
        "INSERT INTO business_profile_edit_audits",
        "(id, business_id, edited_by_user_id, old_version, new_version, old_profile, new_profile, edited_at)",
        "VALUES (?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(3))",
      ].join(" "),
      [auditId, input.businessId, input.userId, previousVersion, newVersion,
       JSON.stringify(before), JSON.stringify(next)]
    );
    return { version: newVersion, auditId, mode: "HOLD", financeModified: false };
  }, getConnection);
}
