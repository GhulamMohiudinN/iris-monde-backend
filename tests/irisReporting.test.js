const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildIrisReportingSummary,
} = require("../src/modules/irisReporting/summary");

// Dates are relative on purpose. This test previously hardcoded calendar dates
// as "upcoming", which quietly became past dates as time moved on and made the
// overdue/nextDue assertions impossible to satisfy.
const daysFromNow = (days) => {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
};

test("buildIrisReportingSummary computes status and evidence metrics", () => {
  const dueSoon = daysFromNow(20);
  const records = [
    {
      status: "in_progress",
      evidenceFiles: [{}, {}, {}],
      dueDate: dueSoon,
    },
    {
      status: "completed",
      evidenceFiles: [{}],
      dueDate: daysFromNow(-30), // already passed
    },
    {
      status: "blocked",
      evidenceFiles: [],
      dueDate: daysFromNow(50),
    },
  ];

  const summary = buildIrisReportingSummary(records);

  assert.equal(summary.total, 3);
  assert.equal(summary.completed, 1);
  assert.equal(summary.inProgress, 1);
  assert.equal(summary.blocked, 1);
  assert.equal(summary.evidenceCount, 4);
  assert.equal(summary.overdueCount, 1);
  assert.equal(summary.complianceScore, 67);
  assert.equal(summary.nextDue, dueSoon);
});

test("buildIrisReportingSummary handles an empty workspace", () => {
  const summary = buildIrisReportingSummary([]);

  assert.equal(summary.total, 0);
  assert.equal(summary.evidenceCount, 0);
  assert.equal(summary.overdueCount, 0);
  assert.equal(summary.complianceScore, 0, "an empty workspace must not divide by zero");
  assert.equal(summary.nextDue, null);
});
