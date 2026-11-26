import type { CashbookReportPreview } from "./cashbook-report.service";

/**
 * Minimal, self-contained PDF 1.4 cash summary for the private pilot.
 *
 * Uses only numeric/ASCII English report fields and Base-14 Helvetica.
 * The report intentionally omits free-text categories (which may need
 * Tamil/Sinhala font shaping) rather than corrupting or transliterating them.
 * A full localized PDF renderer must replace this before release.
 *
 * One-page layout is bounded to <= 12 year rows / 7 week rows.
 * There is no executable content, image, attachment or dynamic PDF action.
 */
export function renderCashbookSummaryPdf(report: CashbookReportPreview): Buffer {
  if (report.basis !== "CASH" ||
      report.invoiceAmountsIncluded !== false ||
      report.reconciledOpeningBalanceAvailable !== false ||
      report.reportSnapshotSaved !== false ||
      report.pdfGenerated !== false) {
    throw new Error("REPORT_PDF_SOURCE_INVALID");
  }
  const rows: string[] = [
    "NOTETO | CASHBOOK SUMMARY",
    "Private pilot report (English / LKR)",
    "Report period: " + report.reportType + " / " + report.periodKey,
    "From " + report.periodStart + " to " + report.periodEnd,
    "Generated UTC: " + report.generatedAt,
    "",
    "Cash received: LKR " + report.totals.cashInLkr,
    "Cash paid:     LKR " + report.totals.cashOutLkr,
    "Net movement:  LKR " + report.totals.netMovementLkr,
    "Income entries: " + report.totals.incomeEntries,
    "Expense entries: " + report.totals.expenseEntries,
    "",
    "PERIOD BREAKDOWN (actual cash movements)",
    "Period       Received LKR        Paid LKR        Net LKR",
  ];
  const detail = report.reportType === "YEARLY"
    ? report.monthlyBreakdown : report.dailyBreakdown;
  if (detail.length > 12) throw new Error("REPORT_PDF_TOO_MANY_ROWS");
  for (const item of detail) {
    rows.push(
      item.label.padEnd(12) +
      item.cashInLkr.padStart(17) +
      item.cashOutLkr.padStart(16) +
      item.netMovementLkr.padStart(16)
    );
  }
  rows.push(
    "",
    "Recorded cash movement only; this is NOT a bank balance.",
    "Unpaid invoices, receivables and estimated taxes are excluded.",
    "Category details (including Tamil/Sinhala) remain in the CSV report.",
    "This document is not a bank statement or certified tax filing."
  );
  if (rows.length > 42 || rows.some(r => r.length > 100 ||
      /[^\x20-\x7E]/.test(r))) {
    throw new Error("REPORT_PDF_UNSUPPORTED_CONTENT");
  }

  function literal(value: string): string {
    return value.replace(/([\\()])/g, "\\$1");
  }
  const lines: string[] = [];
  let y = 760;
  for (const [i, row] of rows.entries()) {
    const heading = i === 0 || i === 12;
    const size = heading ? 13 : 10;
    // Even zero-length rows are intentional vertical separators.
    lines.push(
      "BT /F1 " + size + " Tf 43 " + y +
      " Td (" + literal(row) + ") Tj ET"
    );
    y -= heading ? 22 : 16;
  }
  const stream = lines.join("\n") + "\n";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] " +
      "/Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>",
    "<< /Length " + Buffer.byteLength(stream, "ascii") +
      " >>\nstream\n" + stream + "endstream",
  ];
  // Byte-exact offsets; no UTF-8 multibyte stream characters are accepted.
  const chunks: Buffer[] = [Buffer.from("%PDF-1.4\n%Noteto\n","ascii")];
  const offsets = [0];
  let length = chunks[0].length;
  for (const [index, object] of objects.entries()) {
    offsets.push(length);
    const bytes = Buffer.from(
      String(index + 1) + " 0 obj\n" + object + "\nendobj\n", "ascii"
    );
    chunks.push(bytes);
    length += bytes.length;
  }
  const xref = length;
  const entries = [
    "0000000000 65535 f ",
    ...offsets.slice(1).map(o => String(o).padStart(10,"0")+" 00000 n "),
  ];
  const trailer = Buffer.from(
    "xref\n0 6\n"+entries.join("\n")+"\n"+
    "trailer\n<< /Size 6 /Root 1 0 R >>\n"+
    "startxref\n"+xref+"\n%%EOF\n","ascii"
  );
  chunks.push(trailer);
  const pdf = Buffer.concat(chunks);
  if (pdf.length > 4*1024*1024) throw new Error("REPORT_PDF_SIZE_LIMIT");
  return pdf;
}
