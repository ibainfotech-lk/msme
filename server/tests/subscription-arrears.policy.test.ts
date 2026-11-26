import assert from "node:assert/strict";
import { test } from "node:test";
import {
  quoteMonthlyArrears,
  MonthlyArrearsError,
  type MonthlyDueRecord,
} from "../src/modules/subscriptions/subscription-arrears.policy";

const started = new Date("2026-12-31T18:30:00.000Z"); // Jan 1, 2027 Colombo
const asOf = new Date("2027-02-02T00:00:00.000Z");
const due = (month: "01" | "02", overrides: Partial<MonthlyDueRecord> = {}): MonthlyDueRecord => ({
  billingMonth: "2027-" + month + "-01",
  dueAt: new Date(month === "01" ? "2026-12-31T18:30:00.000Z" : "2027-01-31T18:30:00.000Z"),
  chargeLkr: "499.00",
  waivedLkr: "0.00",
  status: "OPEN",
  allocations: [],
  ...overrides,
});
const jan = due("01");
const feb = due("02");

function failure(code: string) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof MonthlyArrearsError);
    assert.equal(error.code, code);
    return true;
  };
}

test("January and February both unpaid: LKR 998.00, no late penalty", () => {
  const quote = quoteMonthlyArrears(started, [jan, feb], asOf);
  assert.equal(quote.totalOutstandingLkr, "998.00");
  assert.equal(quote.penaltyLkr, "0.00");
  assert.deepEqual(quote.lines.map(line => line.outstandingLkr), ["499.00", "499.00"]);
  assert.equal(quote.paymentActionAllowed, false);
});

test("verified partial payment reduces January, but February remains full", () => {
  const paid = due("01", {
    allocations: [{
      paymentId: "payment-jan",
      amountLkr: "200.00",
      paymentAmountLkr: "200.00",
      paymentTotalAllocatedLkr: "200.00",
      paymentStatus: "SUCCEEDED",
      paymentVerifiedAt: new Date("2027-01-10T00:00:00.000Z"),
    }],
  });
  const quote = quoteMonthlyArrears(started, [paid, feb], asOf);
  assert.equal(quote.totalOutstandingLkr, "798.00");
  assert.equal(quote.lines[0].verifiedPaidLkr, "200.00");
});

test("fully waived introductory free month is not charged", () => {
  const quote = quoteMonthlyArrears(started, [
    due("01", { status: "WAIVED", waivedLkr: "499.00" }), feb,
  ], asOf);
  assert.equal(quote.totalOutstandingLkr, "499.00");
});

test("non-billable void month incurs no automatic debt", () => {
  const quote = quoteMonthlyArrears(started, [
    due("01", { status: "VOID", chargeLkr: "0.00" }), feb,
  ], asOf);
  assert.equal(quote.totalOutstandingLkr, "499.00");
});

test("current-month due date not reached: no advance collection", () => {
  const snapshot = quoteMonthlyArrears(started, [
    jan, due("02", { dueAt: new Date("2027-02-15T00:00:00.000Z") }),
  ], new Date("2027-02-02T00:00:00.000Z"));
  assert.equal(snapshot.totalOutstandingLkr, "499.00");
  assert.equal(snapshot.lines[1].outstandingLkr, "0.00");
});

test("settled month requires verified full allocations", () => {
  const settled = due("01", {
    status: "SETTLED",
    allocations: [{
      paymentId: "paid-in-full", amountLkr: "499.00", paymentAmountLkr: "499.00",
      paymentTotalAllocatedLkr: "499.00", paymentStatus: "SUCCEEDED",
      paymentVerifiedAt: new Date("2027-01-07T00:00:00.000Z"),
    }],
  });
  assert.equal(quoteMonthlyArrears(started, [settled, feb], asOf).totalOutstandingLkr, "499.00");
});

test("missing historical month fails closed instead of silently under-billing", () => {
  assert.throws(() => quoteMonthlyArrears(started, [feb], asOf), failure("BILLING_HISTORY_INCOMPLETE"));
});

test("duplicate month record fails closed", () => {
  assert.throws(() => quoteMonthlyArrears(started, [jan, jan, feb], asOf), failure("INVALID_BILLING_HISTORY"));
});

test("unverified or refunded allocation is never treated as paid", () => {
  for (const paymentStatus of ["PENDING", "FAILED", "REFUNDED", "SUCCEEDED"]) {
    const entry = due("01", {
      allocations: [{
        paymentId: "attempt", amountLkr: "200.00", paymentAmountLkr: "200.00",
        paymentTotalAllocatedLkr: "200.00", paymentStatus,
        paymentVerifiedAt: paymentStatus === "SUCCEEDED" ? null : new Date("2027-01-07T00:00:00.000Z"),
      }],
    });
    assert.throws(() => quoteMonthlyArrears(started, [entry, feb], asOf),
      failure("PAYMENT_ALLOCATION_RECONCILIATION_REQUIRED"));
  }
});

test("overallocated payment or due fails closed", () => {
  const allocation = {
    paymentId: "attempt", amountLkr: "500.00", paymentAmountLkr: "200.00",
    paymentTotalAllocatedLkr: "500.00", paymentStatus: "SUCCEEDED",
    paymentVerifiedAt: new Date("2027-01-07T00:00:00.000Z"),
  };
  assert.throws(() => quoteMonthlyArrears(started, [
    due("01", { allocations: [allocation] }), feb,
  ], asOf), failure("PAYMENT_ALLOCATION_RECONCILIATION_REQUIRED"));
});

test("invalid monetary values and waivers fail closed", () => {
  assert.throws(() => quoteMonthlyArrears(started, [
    due("01", { chargeLkr: "-499.00" }), feb,
  ], asOf), failure("INVALID_MONEY"));
  assert.throws(() => quoteMonthlyArrears(started, [
    due("01", { waivedLkr: "500.00" }), feb,
  ], asOf), failure("INVALID_WAIVER"));
});

test("invalid as-of date fails closed", () => {
  assert.throws(() => quoteMonthlyArrears(started, [jan, feb], new Date("bad")),
    failure("INVALID_BILLING_DATE"));
});
