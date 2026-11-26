import { Router } from "express";
import { getHeldProfile, updateHeldProfile, HeldProfileError } from "./held-profile.service";
import {
  previewCurrentHeldSubscriptionArrears, ArrearsPreviewError,
} from "./subscription-arrears-preview.service";
import { MonthlyArrearsError } from "./subscription-arrears.policy";
import { evaluateBusinessHoldCapability, SubscriptionHoldAccessError } from "./subscription-hold-access.service";
import { z } from "zod";
import { requireAuth } from "../../middleware/auth.middleware";
import { requireCheckoutOrigin } from "../../middleware/checkout-origin.middleware";
import {
  listPreviousEntries, listPreviouslyGeneratedReports, HeldHistoryError,
} from "./held-history-list.service";
import {
  editHistoricalCashEntry, HistoricalEntryEditError,
} from "../transactions/historical-cash-entry-edit.service";
import {
  loadPreviouslyGeneratedPdf, ArchivedReportError,
} from "../reports/archived-report-download.service";

/**
 * F.16.5.4f: development-only, flag-gated HTTP adapter.
 * Attached at /api/hold-history ONLY when explicitly enabled in development.
 * Existing /api/transactions 503 fallback is not changed.
 */
const router = Router();
router.use(requireAuth);
const ids = z.object({
  businessId: z.string().uuid(),
});
const entryIds = ids.extend({ entryId: z.string().uuid() });
const reportIds = ids.extend({ reportId: z.string().uuid() });
const correction = z.strictObject({
  expectedVersion: z.number().int().min(1),
  amountLkr: z.string(),
  category: z.string(),
  description: z.string(),
  occurredOn: z.string(),
  reason: z.string(),
});

function respondWithError(error: unknown, res: import("express").Response, next: import("express").NextFunction) {
  if (error instanceof HeldHistoryError ||
      error instanceof HistoricalEntryEditError ||
      error instanceof ArchivedReportError ||
      error instanceof SubscriptionHoldAccessError ||
      error instanceof ArrearsPreviewError ||
      error instanceof HeldProfileError) {
    res.status(error.statusCode).json({
      success: false, code: error.code,
    });
    return;
  }
  if (error instanceof MonthlyArrearsError) {
    res.status(409).json({ success: false, code: error.code });
    return;
  }
  next(error);
}

// Backend is the only authority for the current subscription access mode.
// This route returns no payment or transaction side effects.
router.get("/businesses/:businessId/access", async (req, res, next) => {
  const route = ids.safeParse(req.params);
  if (!route.success) {
    res.status(400).json({ success: false, code: "INVALID_HOLD_POLICY_REFERENCE" });
    return;
  }
  try {
    const decision = await evaluateBusinessHoldCapability({
      businessId: route.data.businessId,
      userId: req.session.userId!,
      capability: "VIEW_DASHBOARD",
    });
    if (!decision.allowed) {
      res.status(403).json({ success: false, code: decision.code });
      return;
    }
    res.set("Cache-Control", "private, no-store");
    res.json({ success: true, mode: decision.mode });
  } catch (error) { respondWithError(error, res, next); }
});

// Read-only verified subscription statement. No client-supplied amount, date,
// subscription ID, payment token, or invoice creation is accepted.
router.get("/businesses/:businessId/arrears", async (req, res, next) => {
  const route = ids.safeParse(req.params);
  if (!route.success) {
    res.status(400).json({ success: false, code: "INVALID_ARREARS_REFERENCE" });
    return;
  }
  try {
    const quote = await previewCurrentHeldSubscriptionArrears({
      businessId: route.data.businessId,
      userId: req.session.userId!,
      asOf: new Date(),
    });
    res.set("Cache-Control", "private, no-store");
    res.json({ success: true, ...quote });
  } catch (error) { respondWithError(error, res, next); }
});

// Personal name/language and business contact details only. Immutable legal,
// registration, OTP, billing and tax identity fields are never accepted.
const heldProfileUpdate = z.strictObject({
  expectedVersion: z.number().int().min(0),
  fullName: z.string().min(2).max(150),
  preferredLanguage: z.enum(["en", "ta", "si"]),
  displayName: z.string().min(2).max(150),
  contactEmail: z.string().max(191),
  address: z.string().max(350),
});

router.get("/businesses/:businessId/profile", async (req, res, next) => {
  const route = ids.safeParse(req.params);
  if (!route.success) {
    res.status(400).json({ success: false, code: "INVALID_PROFILE_REFERENCE" });
    return;
  }
  try {
    const data = await getHeldProfile({
      businessId: route.data.businessId, userId: req.session.userId!,
    });
    res.set("Cache-Control", "private, no-store");
    res.json({ success: true, ...data });
  } catch (error) { respondWithError(error, res, next); }
});

router.patch("/businesses/:businessId/profile", requireCheckoutOrigin,
  async (req, res, next) => {
    const route = ids.safeParse(req.params);
    const body = heldProfileUpdate.safeParse(req.body);
    if (!route.success || !body.success) {
      res.status(400).json({ success: false, code: "INVALID_PROFILE_DETAILS" });
      return;
    }
    try {
      const result = await updateHeldProfile({
        businessId: route.data.businessId,
        userId: req.session.userId!,
        ...body.data,
      });
      res.set("Cache-Control", "private, no-store");
      res.json({ success: true, ...result });
    } catch (error) { respondWithError(error, res, next); }
  }
);

router.get("/businesses/:businessId/entries", async (req, res, next) => {
  const route = ids.safeParse(req.params);
  if (!route.success) {
    res.status(400).json({ success: false, code: "INVALID_HISTORY_REFERENCE" });
    return;
  }
  try {
    const data = await listPreviousEntries({
      businessId: route.data.businessId, userId: req.session.userId!,
    });
    res.set("Cache-Control", "private, no-store");
    res.json({ success: true, ...data });
  } catch (error) { respondWithError(error, res, next); }
});

router.get("/businesses/:businessId/reports", async (req, res, next) => {
  const route = ids.safeParse(req.params);
  if (!route.success) {
    res.status(400).json({ success: false, code: "INVALID_HISTORY_REFERENCE" });
    return;
  }
  try {
    const data = await listPreviouslyGeneratedReports({
      businessId: route.data.businessId, userId: req.session.userId!,
    });
    res.set("Cache-Control", "private, no-store");
    res.json({ success: true, ...data });
  } catch (error) { respondWithError(error, res, next); }
});

router.get("/businesses/:businessId/reports/:reportId/pdf", async (req, res, next) => {
  const route = reportIds.safeParse(req.params);
  if (!route.success) {
    res.status(400).json({ success: false, code: "INVALID_ARCHIVE_REFERENCE" });
    return;
  }
  try {
    const archive = await loadPreviouslyGeneratedPdf({
      businessId: route.data.businessId,
      userId: req.session.userId!,
      reportId: route.data.reportId,
    });
    res.set({
      "Cache-Control": "private, no-store",
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${archive.filename}"`,
      "X-Content-Type-Options": "nosniff",
      "Content-Length": String(archive.bytes.length),
    });
    res.end(archive.bytes);
  } catch (error) { respondWithError(error, res, next); }
});

router.patch("/businesses/:businessId/entries/:entryId",
  requireCheckoutOrigin, async (req, res, next) => {
    const route = entryIds.safeParse(req.params);
    const body = correction.safeParse(req.body);
    if (!route.success || !body.success) {
      res.status(400).json({ success: false, code: "INVALID_ENTRY_CORRECTION" });
      return;
    }
    try {
      const result = await editHistoricalCashEntry({
        ...body.data,
        userId: req.session.userId!,
        businessId: route.data.businessId,
        transactionId: route.data.entryId,
      });
      res.set("Cache-Control", "private, no-store");
      res.json({ success: true, ...result });
    } catch (error) { respondWithError(error, res, next); }
  }
);

router.all("*catchall", (_req, res) => {
  res.status(405).json({ success: false, code: "HISTORY_ACTION_DISABLED" });
});
export default router;
