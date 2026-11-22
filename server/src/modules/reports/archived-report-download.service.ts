import { createHash } from "node:crypto";
import type { PoolConnection, RowDataPacket } from "mysql2/promise";
import pool from "../../config/database";
import { findCheckoutBusinessForUpdate } from "../checkout/checkout.repository";
import { decideSubscriptionCapability, type SubscriptionAccessState } from "../subscriptions/subscription-hold-access.policy";

/**
 * F.16.5.4d INTERNAL, read-only archived PDF retrieval.
 * No HTTP endpoint uses this function. A report is only downloadable if
 * it was previously generated and stored with a matching SHA-256 digest.
 * This NEVER re-runs accounting queries, creates reports or changes balances.
 */
export class ArchivedReportError extends Error {
  constructor(public readonly code: string, public readonly statusCode = 403) {
    super(code);
    this.name = "ArchivedReportError";
  }
}

export interface ArchivedReportInput {
  businessId: string;
  userId: string;
  reportId: string;
}
export interface ArchivedPdf {
  id: string;
  filename: string;
  generatedAt: Date;
  contentType: "application/pdf";
  bytes: Buffer;
  checksumSha256: string;
}

interface SubscriptionRow extends RowDataPacket {
  id: string;
  status: SubscriptionAccessState["currentSubscriptionStatus"];
  held_at: Date | null;
}
interface PermissionRow extends RowDataPacket { permitted: number }
interface ArchiveRow extends RowDataPacket {
  id: string;
  generated_at: Date;
  report_type: string;
  period_start: Date;
  period_end: Date;
  content_type: string;
  content_sha256: string;
  content_length: number;
  pdf_bytes: Buffer;
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const digest = /^[a-f0-9]{64}$/;
type ConnectionFactory = () => Promise<PoolConnection>;

export async function loadPreviouslyGeneratedPdf(
  input: ArchivedReportInput,
  getConnection: ConnectionFactory = () => pool.getConnection()
): Promise<ArchivedPdf> {
  if (process.env.NODE_ENV !== "development" ||
      process.env.NOTETO_ARCHIVED_REPORT_DOWNLOAD_ENABLED !== "true") {
    throw new ArchivedReportError("ARCHIVED_REPORT_DOWNLOAD_DISABLED");
  }
  if (!uuid.test(input.businessId) ||
      !uuid.test(input.userId) ||
      !uuid.test(input.reportId)) {
    throw new ArchivedReportError("INVALID_ARCHIVE_REFERENCE", 400);
  }

  const connection = await getConnection();
  let started = false;
  try {
    await connection.beginTransaction();
    started = true;
    const business = await findCheckoutBusinessForUpdate(connection, input.businessId);
    if (!business) throw new ArchivedReportError("BUSINESS_ACCESS_DENIED");

    const [permissions] = await connection.execute<PermissionRow[]>(
      [
        "SELECT 1 AS permitted FROM business_memberships bm",
        "JOIN users u ON u.id = bm.user_id AND u.status = 'ACTIVE'",
        "JOIN roles r ON r.id = bm.role_id AND r.business_id = bm.business_id",
        "JOIN role_permissions rp ON rp.role_id = r.id",
        "JOIN permissions p ON p.id = rp.permission_id",
        "WHERE bm.business_id = ? AND bm.user_id = ?",
        "AND bm.status = 'ACTIVE' AND p.`key` = 'reports.read' LIMIT 1",
      ].join(" "),
      [input.businessId, input.userId]
    );
    if (permissions.length !== 1) throw new ArchivedReportError("REPORT_PERMISSION_DENIED");

    const [subscriptions] = await connection.execute<SubscriptionRow[]>(
      [
        "SELECT bs.id, bs.status, bs.held_at",
        "FROM businesses b JOIN business_subscriptions bs",
        "ON bs.id = b.current_subscription_id AND bs.business_id = b.id",
        "WHERE b.id = ? FOR UPDATE",
      ].join(" "),
      [input.businessId]
    );
    if (subscriptions.length !== 1) throw new ArchivedReportError("SUBSCRIPTION_ACCESS_LOCKED");
    const current = subscriptions[0];

    const [archives] = await connection.execute<ArchiveRow[]>(
      [
        "SELECT id, generated_at, report_type, period_start, period_end,",
        "content_type, content_sha256, content_length, pdf_bytes",
        "FROM archived_report_snapshots",
        "WHERE id = ? AND business_id = ? LIMIT 1",
      ].join(" "),
      [input.reportId, input.businessId]
    );
    const archive = archives[0];
    if (!archive) throw new ArchivedReportError("ARCHIVED_REPORT_NOT_FOUND", 404);

    const generatedAt = archive.generated_at;
    if (!(generatedAt instanceof Date) || !Number.isFinite(generatedAt.getTime())) {
      throw new ArchivedReportError("REPORT_PROVENANCE_REQUIRED");
    }
    const heldAt = current.held_at;
    const generatedBeforeHold =
      heldAt instanceof Date && Number.isFinite(heldAt.getTime()) &&
      generatedAt.getTime() <= heldAt.getTime();

    const decision = decideSubscriptionCapability({
      businessStatus: business.status as SubscriptionAccessState["businessStatus"],
      currentSubscriptionStatus: current.status,
      hasAuthorizedMembership: true,
    }, "DOWNLOAD_SAVED_REPORT", {
      kind: "SAVED_REPORT",
      sameBusiness: true,
      generatedBeforeHold,
      immutableSnapshot: true,
    });
    if (!decision.allowed) {
      throw new ArchivedReportError(decision.code);
    }

    if (archive.content_type !== "application/pdf" ||
        !Buffer.isBuffer(archive.pdf_bytes) ||
        archive.pdf_bytes.length < 9 ||
        archive.pdf_bytes.length > 4 * 1024 * 1024 ||
        Number(archive.content_length) !== archive.pdf_bytes.length ||
        !digest.test(archive.content_sha256) ||
        !archive.pdf_bytes.subarray(0, 5).equals(Buffer.from("%PDF-"))) {
      throw new ArchivedReportError("ARCHIVED_REPORT_INTEGRITY_FAILED");
    }
    const checksum = createHash("sha256").update(archive.pdf_bytes).digest("hex");
    if (checksum !== archive.content_sha256) {
      throw new ArchivedReportError("ARCHIVED_REPORT_INTEGRITY_FAILED");
    }
    if (!["DAILY", "WEEKLY", "YEARLY"].includes(archive.report_type)) {
      throw new ArchivedReportError("ARCHIVED_REPORT_INTEGRITY_FAILED");
    }

    const fileName = "noteto-" + archive.report_type.toLowerCase() +
      "-" + generatedAt.toISOString().slice(0, 10) + ".pdf";
    await connection.commit();
    started = false;
    return {
      id: archive.id,
      filename: fileName,
      generatedAt,
      contentType: "application/pdf",
      bytes: Buffer.from(archive.pdf_bytes),
      checksumSha256: checksum,
    };
  } catch (error) {
    if (started) await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}
