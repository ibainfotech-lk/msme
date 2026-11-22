import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.middleware";
import { requireCheckoutOrigin } from "../middleware/checkout-origin.middleware";
import {
  createCashEntry, updateActiveCashEntry, listActiveCashEntries,
  CoreCashbookError,
} from "../modules/transactions/core-cashbook.service";

const router = Router();
/**
 * F.17.1 — private development cashbook API. The production behavior remains
 * 503 FEATURE_NOT_READY. No invoice, payment, report or delete route exists.
 */
router.use((_req, res, next) => {
  if (process.env.NODE_ENV !== "development" ||
      process.env.NOTETO_F17_BOOKKEEPING_ENABLED !== "true") {
    res.status(503).json({
      success: false, code: "FEATURE_NOT_READY",
      message: "Transaction services are not yet available.",
    });
    return;
  }
  next();
});
router.use(requireAuth);

const business = z.strictObject({ businessId: z.uuid() });
const itemRef = z.strictObject({
  businessId: z.uuid(), transactionId: z.uuid(),
});
const fields = {
  amountLkr: z.string(),
  category: z.string(),
  description: z.string(),
  occurredOn: z.string(),
};
const createBody = z.strictObject({
  ...fields,
  transactionType: z.enum(["INCOME", "EXPENSE"]),
  cashConfirmed: z.literal(true),
  idempotencyKey: z.string(),
});
const updateBody = z.strictObject({
  ...fields,
  expectedVersion: z.number().int().min(1),
  reason: z.string(),
});
const paging = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursorDate: z.string().optional(),
  cursorId: z.uuid().optional(),
});
function failed(err: unknown, res: import("express").Response, next: import("express").NextFunction) {
  if (err instanceof CoreCashbookError) {
    res.status(err.statusCode).json({ success: false, code: err.code });
    return;
  }
  next(err);
}

router.get("/businesses/:businessId", async (req, res, next) => {
  const p = business.safeParse(req.params);
  const q = paging.safeParse(req.query);
  if (!p.success || !q.success ||
      Boolean(q.data?.cursorDate) !== Boolean(q.data?.cursorId)) {
    res.status(400).json({ success: false, code: "INVALID_CASHBOOK_PAGE" });
    return;
  }
  try {
    const result = await listActiveCashEntries({
      businessId: p.data.businessId,
      userId: req.session.userId!,
      limit: q.data.limit,
      cursor: q.data.cursorDate && q.data.cursorId
        ? { occurredOn: q.data.cursorDate, id: q.data.cursorId }
        : undefined,
    });
    res.set("Cache-Control", "private, no-store");
    res.json({ success: true, ...result });
  } catch (error) { failed(error, res, next); }
});

router.post("/businesses/:businessId", requireCheckoutOrigin,
  async (req, res, next) => {
    const p = business.safeParse(req.params);
    const body = createBody.safeParse(req.body);
    if (!p.success || !body.success) {
      res.status(400).json({ success: false, code: "INVALID_CASH_ENTRY" });
      return;
    }
    try {
      const result = await createCashEntry({
        businessId: p.data.businessId,
        userId: req.session.userId!,
        ...body.data,
      });
      res.set("Cache-Control", "private, no-store");
      res.status(result.created ? 201 : 200).json({ success: true, ...result });
    } catch (error) { failed(error, res, next); }
  }
);

router.patch("/businesses/:businessId/:transactionId", requireCheckoutOrigin,
  async (req, res, next) => {
    const p = itemRef.safeParse(req.params);
    const body = updateBody.safeParse(req.body);
    if (!p.success || !body.success) {
      res.status(400).json({ success: false, code: "INVALID_CASH_EDIT" });
      return;
    }
    try {
      const result = await updateActiveCashEntry({
        businessId: p.data.businessId,
        userId: req.session.userId!,
        transactionId: p.data.transactionId,
        ...body.data,
      });
      res.set("Cache-Control", "private, no-store");
      res.json({ success: true, ...result });
    } catch (error) { failed(error, res, next); }
  }
);

router.use((_req, res) => {
  res.status(405).json({ success: false, code: "CASHBOOK_ACTION_DISABLED" });
});
export default router;
