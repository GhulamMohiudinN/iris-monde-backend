const nodemailer = require("nodemailer");
const httpStatus = require("http-status");
const ApiError   = require("../../utils/ApiError");
const config     = require("../../config/config");

const transport = nodemailer.createTransport(config.email.smtp);

const escapeHtml = (value = "") =>
  String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

/**
 * Renders the bank block, or nothing at all when no account details were given.
 *
 * Every field is optional and only the ones supplied are shown, so the same
 * template serves an Australian BSB/account pair and an international
 * SWIFT/IBAN without printing empty labels on the invoice.
 */
const buildBankSection = (bank, currency) => {
  const rows = [
    ["Bank", bank?.bankName],
    ["Account name", bank?.accountName],
    ["BSB", bank?.bsb],
    ["Account number", bank?.accountNumber],
    ["SWIFT / BIC", bank?.swift],
  ].filter(([, value]) => value);

  if (!rows.length) return "";

  const cells = rows
    .map(
      ([label, value]) => `
        <tr>
          <td style="padding:4px 12px 4px 0;font-size:12px;color:#64748b;white-space:nowrap;">${escapeHtml(label)}</td>
          <td style="padding:4px 0;font-size:13px;font-weight:bold;color:#111827;">${escapeHtml(value)}</td>
        </tr>`
    )
    .join("");

  return `
    <div style="margin-top:24px;padding:16px;background:#f8fafc;border-left:3px solid #2563eb;">
      <p style="font-size:11px;font-weight:bold;text-transform:uppercase;color:#64748b;margin:0 0 8px;">
        Payment Details${currency ? ` (${escapeHtml(currency)})` : ""}
      </p>
      <table style="border-collapse:collapse;">${cells}</table>
      <p style="margin:12px 0 0;font-size:11px;color:#64748b;line-height:1.5;">
        These account details do not change. If you receive a request to pay a
        different account, please call us on a number you already hold to verify
        before paying.
      </p>
    </div>`;
};

const buildInvoiceHtml = ({
  invoiceNumber, issueDate, servicePeriod,
  supplier, client, items, currency, totalAmount, paymentTerms, notes, bank,
}) => {
  const rows = (items || [])
    .map(
      (item) => `
        <tr>
          <td style="padding:10px 12px;border-bottom:1px solid #e2e8f0;">${escapeHtml(item.description)}</td>
          <td style="padding:10px 12px;border-bottom:1px solid #e2e8f0;">${escapeHtml(item.period)}</td>
          <td style="padding:10px 12px;border-bottom:1px solid #e2e8f0;text-align:right;">${escapeHtml(item.amount)} ${escapeHtml(currency)}</td>
        </tr>`
    )
    .join("");

  return `
  <div style="font-family:Arial,Helvetica,sans-serif;max-width:640px;margin:0 auto;color:#111827;">
    <h1 style="font-size:24px;margin-bottom:4px;">INVOICE</h1>
    <p style="margin:2px 0;font-size:13px;"><strong>Invoice #:</strong> ${escapeHtml(invoiceNumber)}</p>
    <p style="margin:2px 0;font-size:13px;"><strong>Issue Date:</strong> ${escapeHtml(issueDate)}</p>
    ${servicePeriod ? `<p style="margin:2px 0;font-size:13px;"><strong>Service Period:</strong> ${escapeHtml(servicePeriod)}</p>` : ""}

    <table style="width:100%;margin-top:20px;">
      <tr>
        <td style="vertical-align:top;width:50%;">
          <p style="font-size:11px;font-weight:bold;text-transform:uppercase;color:#64748b;margin-bottom:4px;">Supplier</p>
          <p style="margin:2px 0;font-size:13px;font-weight:bold;">${escapeHtml(supplier?.name)}</p>
          ${supplier?.abn ? `<p style="margin:2px 0;font-size:12px;">ABN: ${escapeHtml(supplier.abn)}</p>` : ""}
          ${supplier?.address ? `<p style="margin:2px 0;font-size:12px;white-space:pre-line;">${escapeHtml(supplier.address)}</p>` : ""}
          ${supplier?.website ? `<p style="margin:2px 0;font-size:12px;">${escapeHtml(supplier.website)}</p>` : ""}
        </td>
        <td style="vertical-align:top;width:50%;">
          <p style="font-size:11px;font-weight:bold;text-transform:uppercase;color:#64748b;margin-bottom:4px;">Client</p>
          <p style="margin:2px 0;font-size:13px;font-weight:bold;">${escapeHtml(client?.name)}</p>
          ${client?.representative ? `<p style="margin:2px 0;font-size:12px;">Represented by ${escapeHtml(client.representative)}</p>` : ""}
          ${client?.address ? `<p style="margin:2px 0;font-size:12px;white-space:pre-line;">${escapeHtml(client.address)}</p>` : ""}
        </td>
      </tr>
    </table>

    <table style="width:100%;border-collapse:collapse;margin-top:24px;">
      <thead>
        <tr style="background:#f8fafc;">
          <th style="padding:10px 12px;text-align:left;font-size:11px;text-transform:uppercase;color:#64748b;">Description</th>
          <th style="padding:10px 12px;text-align:left;font-size:11px;text-transform:uppercase;color:#64748b;">Period</th>
          <th style="padding:10px 12px;text-align:right;font-size:11px;text-transform:uppercase;color:#64748b;">Amount</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>

    <div style="margin-top:20px;text-align:right;">
      <p style="font-size:12px;color:#64748b;margin:2px 0;">TOTAL DUE</p>
      <p style="font-size:22px;font-weight:bold;margin:2px 0;">${escapeHtml(totalAmount)} ${escapeHtml(currency)}</p>
    </div>

    ${buildBankSection(bank, currency)}

    ${paymentTerms ? `<p style="margin-top:20px;font-size:12px;color:#64748b;"><strong>Payment Terms:</strong> ${escapeHtml(paymentTerms)}</p>` : ""}
    ${notes ? `<p style="margin-top:8px;font-size:12px;color:#64748b;">${escapeHtml(notes)}</p>` : ""}
  </div>`;
};

const sendInvoice = async ({ to, invoice, actor }) => {
  if (!to) throw new ApiError(httpStatus.BAD_REQUEST, "Recipient email is required");
  if (!invoice?.invoiceNumber || !invoice?.totalAmount) {
    throw new ApiError(httpStatus.BAD_REQUEST, "Invoice number and total amount are required");
  }

  const html = buildInvoiceHtml(invoice);
  const subject = `Invoice ${invoice.invoiceNumber}${invoice.supplier?.name ? ` — ${invoice.supplier.name}` : ""}`;

  await transport.sendMail({
    from: config.email.from,
    to,
    subject,
    html,
  });

  return { sentTo: to, invoiceNumber: invoice.invoiceNumber, sentBy: actor?.name || actor?.email || "Unknown" };
};

module.exports = { sendInvoice, buildInvoiceHtml };
