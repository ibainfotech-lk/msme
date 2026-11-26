/**
 * F.16.5.4a — READ-ONLY calculation of monthly subscription arrears.
 * No invoice creation, payment attempt, debt posting or gateway activity.
 * Ledger entries must be produced by a separately reviewed billing process.
 * Monetary values are parsed as integer cents (LKR two decimal places).
 */
export type MonthlyDueStatus = "OPEN" | "SETTLED" | "WAIVED" | "VOID";

export interface VerifiedDueAllocation {
  paymentId: string;
  amountLkr: string;
  paymentAmountLkr: string;
  paymentTotalAllocatedLkr: string;
  paymentStatus: string;
  paymentVerifiedAt: Date | null;
}

export interface MonthlyDueRecord {
  billingMonth: string; // YYYY-MM-01 in Asia/Colombo billing calendar
  dueAt: Date; // UTC instant matching agreed billing date in Sri Lanka
  status: MonthlyDueStatus;
  chargeLkr: string;
  waivedLkr: string;
  allocations: readonly VerifiedDueAllocation[];
}

export interface MonthlyArrearsLine {
  billingMonth: string;
  chargeLkr: string;
  waivedLkr: string;
  verifiedPaidLkr: string;
  outstandingLkr: string;
}

export interface MonthlyArrearsQuote {
  currency: "LKR";
  asOf: string;
  lines: MonthlyArrearsLine[];
  totalOutstandingLkr: string;
  penaltyLkr: "0.00";
  completeThroughMonth: string;
  paymentActionAllowed: false;
}

export class MonthlyArrearsError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "MonthlyArrearsError";
  }
}

const moneyPattern = /^(?:0|[1-9]\d{0,9})\.\d{2}$/;
const monthPattern = /^(\d{4})-(0[1-9]|1[0-2])-01$/;

function cents(value: string): number {
  if (typeof value !== "string" || !moneyPattern.test(value)) {
    throw new MonthlyArrearsError("INVALID_MONEY");
  }
  const [whole, fraction] = value.split(".");
  const result = Number(whole) * 100 + Number(fraction);
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new MonthlyArrearsError("INVALID_MONEY");
  }
  return result;
}

function lkr(amountCents: number): string {
  if (!Number.isSafeInteger(amountCents) || amountCents < 0) {
    throw new MonthlyArrearsError("INVALID_MONEY");
  }
  const major = Math.floor(amountCents / 100);
  return major.toString() + "." + String(amountCents % 100).padStart(2, "0");
}

function validDate(date: Date): boolean {
  return date instanceof Date && Number.isFinite(date.getTime());
}

function monthIndex(month: string): number {
  const match = monthPattern.exec(month);
  if (!match) throw new MonthlyArrearsError("INVALID_BILLING_MONTH");
  const year = Number(match[1]);
  if (year < 2000 || year > 9999) {
    throw new MonthlyArrearsError("INVALID_BILLING_MONTH");
  }
  return year * 12 + Number(match[2]) - 1;
}

function monthKey(index: number): string {
  const year = Math.floor(index / 12);
  return year.toString().padStart(4, "0") + "-" +
    String(index % 12 + 1).padStart(2, "0") + "-01";
}

function colomboMonthIndex(date: Date): number {
  if (!validDate(date)) throw new MonthlyArrearsError("INVALID_BILLING_DATE");
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Colombo",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(date);
  const year = Number(parts.find(p => p.type === "year")?.value);
  const month = Number(parts.find(p => p.type === "month")?.value);
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
    throw new MonthlyArrearsError("INVALID_BILLING_DATE");
  }
  return year * 12 + month - 1;
}

/**
 * Requires one reviewed ledger row for EVERY month from subscription start
 * through the Sri Lanka-local as-of month. Free months must be explicit
 * WAIVED rows, and non-billable months explicit VOID rows. Never infer charges
 * from date differences alone, preventing accidental back-billing.
 */
export function quoteMonthlyArrears(
  subscriptionStartsAt: Date,
  records: readonly MonthlyDueRecord[],
  asOf: Date
): MonthlyArrearsQuote {
  const firstMonth = colomboMonthIndex(subscriptionStartsAt);
  const lastMonth = colomboMonthIndex(asOf);
  const months = lastMonth - firstMonth + 1;
  if (months < 1 || months > 240) {
    throw new MonthlyArrearsError("BILLING_PERIOD_REQUIRES_REVIEW");
  }

  const byMonth = new Map<number, MonthlyDueRecord>();
  for (const record of records) {
    const index = monthIndex(record.billingMonth);
    if (byMonth.has(index) || index < firstMonth) {
      throw new MonthlyArrearsError("INVALID_BILLING_HISTORY");
    }
    byMonth.set(index, record);
  }

  const lines: MonthlyArrearsLine[] = [];
  let totalCents = 0;
  const seenPaymentAllocation = new Set<string>();
  for (let index = firstMonth; index <= lastMonth; index++) {
    const record = byMonth.get(index);
    if (!record) throw new MonthlyArrearsError("BILLING_HISTORY_INCOMPLETE");
    if (!validDate(record.dueAt)) throw new MonthlyArrearsError("INVALID_DUE_DATE");
    const charge = cents(record.chargeLkr);
    const waived = cents(record.waivedLkr);
    if (waived > charge) throw new MonthlyArrearsError("INVALID_WAIVER");

    if (!["OPEN", "SETTLED", "WAIVED", "VOID"].includes(record.status)) {
      throw new MonthlyArrearsError("INVALID_DUE_STATUS");
    }
    const billable = charge - waived;
    if ((record.status === "WAIVED" && billable !== 0) ||
        (record.status === "VOID" && (charge !== 0 || waived !== 0))) {
      throw new MonthlyArrearsError("INVALID_NON_BILLABLE_MONTH");
    }

    let paid = 0;
    for (const allocation of record.allocations) {
      const paymentCents = cents(allocation.paymentAmountLkr);
      const allocatedTotal = cents(allocation.paymentTotalAllocatedLkr);
      const allocated = cents(allocation.amountLkr);
      if (!allocation.paymentId || allocated <= 0 ||
          seenPaymentAllocation.has(record.billingMonth + ":" + allocation.paymentId) ||
          allocation.paymentStatus !== "SUCCEEDED" ||
          !validDate(allocation.paymentVerifiedAt as Date) ||
          allocation.paymentVerifiedAt!.getTime() > asOf.getTime() ||
          allocatedTotal > paymentCents) {
        throw new MonthlyArrearsError("PAYMENT_ALLOCATION_RECONCILIATION_REQUIRED");
      }
      seenPaymentAllocation.add(record.billingMonth + ":" + allocation.paymentId);
      paid += allocated;
      if (!Number.isSafeInteger(paid)) throw new MonthlyArrearsError("INVALID_MONEY");
    }
    if (paid > billable ||
        (record.status === "SETTLED" && paid !== billable) ||
        (record.status === "OPEN" && paid === billable && billable > 0) ||
        ((record.status === "VOID" || record.status === "WAIVED") && paid !== 0)) {
      throw new MonthlyArrearsError("PAYMENT_ALLOCATION_RECONCILIATION_REQUIRED");
    }

    // Do not collect before the actual agreed due instant.
    const outstanding = record.dueAt.getTime() <= asOf.getTime() ? billable - paid : 0;
    totalCents += outstanding;
    if (!Number.isSafeInteger(totalCents)) throw new MonthlyArrearsError("INVALID_MONEY");
    lines.push({
      billingMonth: record.billingMonth,
      chargeLkr: record.chargeLkr,
      waivedLkr: record.waivedLkr,
      verifiedPaidLkr: lkr(paid),
      outstandingLkr: lkr(outstanding),
    });
  }
  return {
    currency: "LKR",
    asOf: asOf.toISOString(),
    lines,
    totalOutstandingLkr: lkr(totalCents),
    penaltyLkr: "0.00",
    completeThroughMonth: monthKey(lastMonth),
    paymentActionAllowed: false,
  };
}
