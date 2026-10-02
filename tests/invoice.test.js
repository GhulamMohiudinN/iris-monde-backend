/**
 * Invoice template.
 *
 * An invoice is the one document in this product that tells somebody where to
 * send money, so the bank block has to be exactly right: present when details
 * were given, absent (not blank-labelled) when they were not, and escaped,
 * because every value here is typed by a user and rendered as HTML in an email.
 */
const test = require("node:test");
const assert = require("node:assert/strict");

const { buildInvoiceHtml } = require("../src/modules/invoice/service");

const baseInvoice = (overrides = {}) => ({
  invoiceNumber: "INV-2026-001",
  issueDate: "2026-10-02",
  currency: "AUD",
  totalAmount: "4800.00",
  supplier: { name: "Reseaux Access Pty Ltd", abn: "12 345 678 901" },
  client: { name: "Acme Pty Ltd" },
  items: [{ description: "Compliance review", period: "October 2026", amount: "4800.00" }],
  ...overrides,
});

const fullBank = {
  bankName: "Commonwealth Bank",
  accountName: "Reseaux Access Pty Ltd",
  bsb: "063-000",
  accountNumber: "1234 5678",
  swift: "CTBAAU2S",
};

// ─── Addresses ───────────────────────────────────────────────────────────────
test("the supplier address appears on the invoice", () => {
  const html = buildInvoiceHtml(
    baseInvoice({
      supplier: { name: "Reseaux Access", address: "Level 5, 120 Collins Street\nMelbourne VIC 3000" },
    })
  );
  assert.ok(html.includes("120 Collins Street"), "the supplier address must be rendered");
  assert.ok(html.includes("Melbourne VIC 3000"));
});

test("a multi-line address keeps its line breaks", () => {
  const html = buildInvoiceHtml(
    baseInvoice({ supplier: { name: "X", address: "Line one\nLine two" } })
  );
  // Without white-space:pre-line the newline collapses and the address runs together.
  assert.match(html, /white-space:pre-line/, "line breaks in an address must survive into the email");
});

test("no address means no empty line, not a blank one", () => {
  const html = buildInvoiceHtml(baseInvoice());
  assert.ok(!html.includes("white-space:pre-line"), "nothing should be emitted for an absent address");
});

// ─── Header ──────────────────────────────────────────────────────────────────
test("an omitted issue date leaves no dangling label", () => {
  // Found by sending a real invoice: the issue date printed its label whether
  // or not a date was given, so an invoice sent without one carried a bare
  // "Issue Date:" with nothing after it.
  const html = buildInvoiceHtml(baseInvoice({ issueDate: "" }));
  assert.ok(!html.includes("Issue Date"), "no date means the label should not appear at all");

  const withDate = buildInvoiceHtml(baseInvoice({ issueDate: "2026-10-02" }));
  assert.ok(withDate.includes("Issue Date"), "a date that was given must still be shown");
  assert.ok(withDate.includes("2026-10-02"));
});

// ─── Bank details ────────────────────────────────────────────────────────────
test("every bank field given is shown with its label", () => {
  const html = buildInvoiceHtml(baseInvoice({ bank: fullBank }));

  assert.ok(html.includes("Payment Details"), "the section needs a heading");
  for (const [label, value] of [
    ["Bank", "Commonwealth Bank"],
    ["Account name", "Reseaux Access Pty Ltd"],
    ["BSB", "063-000"],
    ["Account number", "1234 5678"],
    ["SWIFT / BIC", "CTBAAU2S"],
  ]) {
    assert.ok(html.includes(label), `${label} label missing`);
    assert.ok(html.includes(value), `${label} value missing`);
  }
});

test("the currency is stated next to the payment details", () => {
  const html = buildInvoiceHtml(baseInvoice({ currency: "AUD", bank: fullBank }));
  assert.match(html, /Payment Details \(AUD\)/, "paying the wrong currency is a real mistake — say which one");
});

test("only the fields that were filled in appear", () => {
  // An overseas supplier has a SWIFT and no BSB; a local one the reverse.
  const html = buildInvoiceHtml(
    baseInvoice({ bank: { accountName: "Reseaux Access", swift: "CTBAAU2S" } })
  );

  assert.ok(html.includes("SWIFT / BIC"));
  assert.ok(html.includes("Account name"));
  assert.ok(!html.includes("BSB"), "an empty BSB must not print a blank labelled row");
  assert.ok(!html.includes("Account number"), "an empty account number must not print a blank row");
});

test("no bank details means no payment section at all", () => {
  assert.ok(!buildInvoiceHtml(baseInvoice()).includes("Payment Details"));
  assert.ok(!buildInvoiceHtml(baseInvoice({ bank: {} })).includes("Payment Details"));
  assert.ok(
    !buildInvoiceHtml(baseInvoice({ bank: { bankName: "", bsb: "" } })).includes("Payment Details"),
    "fields present but empty must still produce nothing"
  );
});

test("the invoice warns against account-change requests", () => {
  // Invoice redirection fraud works by emailing a "we changed banks" follow-up.
  // The warning is on the invoice itself so the client has seen it beforehand.
  const html = buildInvoiceHtml(baseInvoice({ bank: fullBank }));
  assert.match(html, /do not change/i);
  assert.match(html, /verify/i);
});

// ─── Escaping ────────────────────────────────────────────────────────────────
test("user-typed values cannot inject markup into the email", () => {
  const html = buildInvoiceHtml(
    baseInvoice({
      supplier: { name: "<script>alert(1)</script>", address: "<b>addr</b>" },
      bank: { ...fullBank, accountName: "<img src=x onerror=alert(1)>" },
    })
  );

  assert.ok(!html.includes("<script>"), "a script tag must not survive into the email body");
  assert.ok(!html.includes("<img src=x"), "markup in a bank field must be escaped");
  assert.ok(html.includes("&lt;script&gt;"), "it should appear as text instead");
});
