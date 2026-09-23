/**
 * IRIS business rules.
 *
 * These are the closest thing this product has to compliance enforcement: two
 * of the rules actively block a save, and they are what stops an obligation
 * being marked Completed without the approvals or evidence it claims to
 * require. A silent regression here would let a compliance record be closed
 * out with nothing behind it, which is the worst possible failure mode for a
 * statutory reporting tool.
 */
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  validateRequirement,
  applyMaterialityRules,
  RULES,
} = require("../src/modules/irisReporting/businessRules");

const daysFromNow = (days) => {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toISOString();
};

/** A complete, valid obligation — each test bends one thing out of shape. */
const validObligation = (overrides = {}) => ({
  title: "Annual financial statements",
  status: "planned",
  materiality: "Standard",
  approvalRequired: false,
  approvalStatus: "not_required",
  approvalSteps: [],
  evidenceRequired: [],
  evidenceFiles: [],
  dueDate: daysFromNow(30),
  ...overrides,
});

const ruleIds = (result) => result.violations.map((v) => v.rule);

test("a well-formed obligation raises nothing", () => {
  const result = validateRequirement(validObligation());
  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, []);
});

// ─── Blocking rules ──────────────────────────────────────────────────────────
test("cannot complete an obligation whose approvals are not all approved", () => {
  const pending = validateRequirement(
    validObligation({ status: "completed", approvalRequired: true, approvalStatus: "pending" })
  );
  assert.equal(pending.valid, false, "a pending approval must block completion");
  assert.ok(ruleIds(pending).includes("COMPLETION_REQUIRES_APPROVAL"));

  const rejected = validateRequirement(
    validObligation({ status: "completed", approvalRequired: true, approvalStatus: "rejected" })
  );
  assert.equal(rejected.valid, false, "a rejected approval must block completion");

  const approved = validateRequirement(
    validObligation({ status: "completed", approvalRequired: true, approvalStatus: "approved" })
  );
  assert.equal(approved.valid, true, "an approved obligation must be completable");
});

test("cannot complete an obligation that lists evidence but has none attached", () => {
  const missing = validateRequirement(
    validObligation({
      status: "completed",
      evidenceRequired: ["Signed statements", "Auditor report"],
      evidenceFiles: [],
    })
  );
  assert.equal(missing.valid, false);
  assert.ok(ruleIds(missing).includes("COMPLETION_REQUIRES_EVIDENCE"));

  const attached = validateRequirement(
    validObligation({
      status: "completed",
      evidenceRequired: ["Signed statements"],
      evidenceFiles: [{ fileName: "statements.pdf" }],
    })
  );
  assert.equal(attached.valid, true, "completion must be allowed once evidence exists");
});

test("blank evidence entries do not count as a requirement", () => {
  // The obligation form seeds an empty string row, so [""] means "none listed".
  const result = validateRequirement(
    validObligation({ status: "completed", evidenceRequired: ["", ""], evidenceFiles: [] })
  );
  assert.equal(result.valid, true, "empty placeholder rows must not block completion");
});

test("these two rules block; everything else only advises", () => {
  const blocking = RULES.filter((r) => r.severity === "error").map((r) => r.id);
  assert.deepEqual(
    blocking.sort(),
    ["COMPLETION_REQUIRES_APPROVAL", "COMPLETION_REQUIRES_EVIDENCE"],
    "the set of save-blocking rules changed — this is a deliberate compliance decision"
  );
});

// ─── Advisory rules ──────────────────────────────────────────────────────────
test("high and critical materiality without approval is flagged but not blocked", () => {
  for (const materiality of ["Critical", "High"]) {
    const result = validateRequirement(validObligation({ materiality, approvalRequired: false }));
    assert.ok(ruleIds(result).includes("HIGH_MATERIALITY_NEEDS_APPROVAL"), `${materiality} should warn`);
    assert.equal(result.valid, true, `${materiality} should warn, not block`);
  }

  const standard = validateRequirement(validObligation({ materiality: "Standard", approvalRequired: false }));
  assert.ok(!ruleIds(standard).includes("HIGH_MATERIALITY_NEEDS_APPROVAL"));
});

test("an overdue obligation still marked Planned is flagged", () => {
  const overdue = validateRequirement(validObligation({ dueDate: daysFromNow(-5), status: "planned" }));
  assert.ok(ruleIds(overdue).includes("OVERDUE_NOT_PLANNED"));
  assert.equal(overdue.valid, true);

  const progressed = validateRequirement(validObligation({ dueDate: daysFromNow(-5), status: "in_progress" }));
  assert.ok(!ruleIds(progressed).includes("OVERDUE_NOT_PLANNED"), "only Planned should trigger this");

  const future = validateRequirement(validObligation({ dueDate: daysFromNow(5), status: "planned" }));
  assert.ok(!ruleIds(future).includes("OVERDUE_NOT_PLANNED"));
});

test("a critical obligation with no due date is flagged", () => {
  const result = validateRequirement(
    validObligation({ materiality: "Critical", dueDate: null, approvalRequired: true })
  );
  assert.ok(ruleIds(result).includes("CRITICAL_NEEDS_DUE_DATE"));
  assert.equal(result.valid, true);
});

test("requiring approval without defining any steps is flagged", () => {
  const noSteps = validateRequirement(validObligation({ approvalRequired: true, approvalSteps: [] }));
  assert.ok(
    ruleIds(noSteps).includes("APPROVAL_STEPS_REQUIRED"),
    "an approval requirement with no steps can never be satisfied — it must at least warn"
  );

  const withSteps = validateRequirement(
    validObligation({ approvalRequired: true, approvalSteps: [{ stepName: "CFO Review", order: 1 }] })
  );
  assert.ok(!ruleIds(withSteps).includes("APPROVAL_STEPS_REQUIRED"));
});

test("multiple problems are all reported, not just the first", () => {
  const result = validateRequirement(
    validObligation({
      status: "completed",
      approvalRequired: true,
      approvalStatus: "pending",
      approvalSteps: [],
      evidenceRequired: ["Signed statements"],
      evidenceFiles: [],
      materiality: "Critical",
      dueDate: null,
    })
  );

  assert.equal(result.valid, false);
  assert.equal(result.errors.length, 2, "both blocking rules should fire");
  assert.ok(result.warnings.length >= 2, "advisory rules should still be reported alongside errors");
});

// ─── Materiality auto-rules ──────────────────────────────────────────────────
test("critical and high materiality default to requiring approval", () => {
  for (const materiality of ["Critical", "High"]) {
    const draft = { materiality };
    applyMaterialityRules(draft);
    assert.equal(draft.approvalRequired, true, `${materiality} should default to requiring approval`);
  }
});

test("an explicit approval choice is never overridden", () => {
  const optedOut = { materiality: "Critical", approvalRequired: false };
  applyMaterialityRules(optedOut);
  assert.equal(optedOut.approvalRequired, false, "an explicit false must be respected");

  const standard = { materiality: "Standard" };
  applyMaterialityRules(standard);
  assert.equal(standard.approvalRequired, undefined, "standard materiality should not force approval");
});
