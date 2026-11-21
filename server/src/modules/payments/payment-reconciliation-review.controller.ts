import type { RequestHandler } from "express";

import {
  getPaymentReconciliationReview,
} from "./payment-reconciliation-review.repository";

interface AuthorizedBusinessContext {
  businessId: string;
  userId: string;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Internal, read-only reconciliation review controller.
 *
 * Expected middleware order:
 *   requireAuth
 *   requireBusinessAccess
 *   requirePermission("billing.manage")
 *   getPaymentReconciliationReviewController
 *
 * Do not register a public route until HTTP authorization
 * and response tests are complete.
 */
export const getPaymentReconciliationReviewController:
  RequestHandler = async (req, res, next) => {
    try {
      // Feature remains disabled in production.
      if (process.env.NODE_ENV === "production") {
        res.status(404).json({
          success: false,
          code: "RECONCILIATION_REVIEW_DISABLED",
          message: "Reconciliation review is not available.",
        });
        return;
      }

      const access = res.locals.businessAccess as
        | AuthorizedBusinessContext
        | undefined;

      // Identity must come from the authenticated session.
      const sessionUserId = req.session?.userId;

      // Business and payment identifiers come from the route.
      const requestedBusinessId = req.params.businessId;
      const requestedPaymentId = req.params.paymentId;

      // Fail closed if the verified context is absent,
      // invalid, or inconsistent with session and URL.
      if (
        !access ||
        typeof access.businessId !== "string" ||
        typeof access.userId !== "string" ||
        !UUID_PATTERN.test(access.businessId) ||
        !UUID_PATTERN.test(access.userId) ||
        access.userId !== sessionUserId ||
        access.businessId !== requestedBusinessId
      ) {
        res.status(403).json({
          success: false,
          code: "BUSINESS_CONTEXT_MISMATCH",
          message: "Invalid business authorization context.",
        });
        return;
      }

      if (
        typeof requestedPaymentId !== "string" ||
        !UUID_PATTERN.test(requestedPaymentId)
      ) {
        res.status(400).json({
          success: false,
          code: "INVALID_PAYMENT_ID",
          message: "A valid payment ID is required.",
        });
        return;
      }

      // The repository independently checks billing.manage
      // and requires the payment to belong to this business.
      const review = await getPaymentReconciliationReview(
        requestedPaymentId,
        access.businessId,
        access.userId
      );

      // Same response for missing and unauthorized payments.
      if (!review) {
        res.status(404).json({
          success: false,
          code: "PAYMENT_REVIEW_NOT_FOUND",
          message: "Payment review was not found.",
        });
        return;
      }

      // Advisory information only.
      // No payment, checkout, subscription or gateway action.
      res.status(200).json({
        success: true,
        data: review,
      });

    } catch (error) {
      next(error);
    }
  };