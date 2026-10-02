/**
 * Workspace deletion.
 *
 * The most destructive thing the product can do, and the one place where a
 * scoping mistake is unrecoverable: a deleteMany that forgets its workspaceId
 * filter wipes every tenant at once, with no undo. These tests run the real
 * service against a real (in-memory) MongoDB with two tenants present and
 * assert that deleting one leaves the other completely untouched.
 *
 * Run with: npm run test:isolation
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

process.env.JWT_SECRET = process.env.JWT_SECRET || "deletion-test-secret";

const Workspace = require("../src/modules/workspace/model");
const { User } = require("../src/models");
const { IrisReportingRequirement } = require("../src/modules/irisReporting/model");
const { Contract } = require("../src/modules/contract/model");
const { Process } = require("../src/modules/process/model");
const { Step } = require("../src/modules/step/model");
const { Template } = require("../src/modules/template/model");
const { ReportTemplate } = require("../src/modules/reportTemplate/model");
const { ActivityLog } = require("../src/modules/activityLog/model");

const workspaceService = require("../src/modules/workspace/service");

let mongod;
let doomed;   // the workspace being deleted
let survivor; // the one that must be untouched

/** Gives a workspace one record of every type that belongs to it. */
const populate = async (workspaceId, label) => {
  await IrisReportingRequirement.create({ workspaceId, title: `${label} obligation`, status: "planned" });
  await Contract.create({
    workspaceId, title: `${label} NDA`, content: "terms",
    recipientName: "R", recipientEmail: `r@${label}.test`,
    ownerEmail: `o@${label}.test`, signToken: `${label}-token`,
  });
  const process = await Process.create({ workspaceId, name: `${label} process` });
  await Step.create({ workspaceId, processId: process._id, title: `${label} step`, sequenceNo: 1 });
  await Template.create({ workspaceId, name: `${label} template` });
  await ReportTemplate.create({
    workspaceId, name: `${label} report`, fileName: "r.docx",
    fileType: "docx", url: "https://example.test/r.docx",
  });
  await ActivityLog.create({
    workspaceId, userId: new mongoose.Types.ObjectId(),
    action: "invite_member", entityType: "process", message: `${label} did a thing`,
  });
  await User.create({
    workspaceId, name: `${label} member`, email: `member@${label}.test`,
    username: `${label}-member`, password: "Password123", userType: "member",
  });
};

const countsFor = async (workspaceId) => {
  const [obligations, contracts, processes, steps, templates, reports, logs, users] = await Promise.all([
    IrisReportingRequirement.countDocuments({ workspaceId }),
    Contract.countDocuments({ workspaceId }),
    Process.countDocuments({ workspaceId }),
    Step.countDocuments({ workspaceId }),
    Template.countDocuments({ workspaceId }),
    ReportTemplate.countDocuments({ workspaceId }),
    ActivityLog.countDocuments({ workspaceId }),
    User.countDocuments({ workspaceId }),
  ]);
  return { obligations, contracts, processes, steps, templates, reports, logs, users };
};

test.before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());

  const doomedAdmin = await User.create({
    name: "Doomed Admin", email: "admin@doomed.test", username: "doomed-admin",
    password: "Password123", userType: "admin",
  });
  doomed = await Workspace.create({
    adminId: doomedAdmin._id, adminEmail: doomedAdmin.email,
    companyEmail: "co@doomed.test", companyName: "Doomed Pty Ltd", userName: "doomed-pty",
  });
  doomedAdmin.workspaceId = doomed._id;
  await doomedAdmin.save();

  const survivorAdmin = await User.create({
    name: "Survivor Admin", email: "admin@survivor.test", username: "survivor-admin",
    password: "Password123", userType: "admin",
  });
  survivor = await Workspace.create({
    adminId: survivorAdmin._id, adminEmail: survivorAdmin.email,
    companyEmail: "co@survivor.test", companyName: "Survivor Pty Ltd", userName: "survivor-pty",
  });
  survivorAdmin.workspaceId = survivor._id;
  await survivorAdmin.save();

  await populate(doomed._id, "doomed");
  await populate(survivor._id, "survivor");
});

test.after(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

test("the fixture starts with both tenants fully populated", async () => {
  const before = await countsFor(doomed._id);
  for (const [name, count] of Object.entries(before)) {
    assert.ok(count > 0, `${name} should exist before deletion, or the test proves nothing`);
  }
  assert.equal((await countsFor(survivor._id)).obligations, 1);
});

test("deleting a workspace removes every kind of record it owned", async () => {
  const result = await workspaceService.deleteWorkspaceAndData(doomed._id);

  assert.equal(result.companyName, "Doomed Pty Ltd");

  const after = await countsFor(doomed._id);
  for (const [name, count] of Object.entries(after)) {
    assert.equal(count, 0, `${name} should have been deleted`);
  }

  assert.equal(await Workspace.countDocuments({ _id: doomed._id }), 0, "the workspace itself must be gone");
});

test("the administrator's own account goes with it", async () => {
  // Leaving it behind strands an account that can reach no workspace and,
  // with self-registration closed, could never create another.
  assert.equal(await User.countDocuments({ email: "admin@doomed.test" }), 0);
});

test("the other tenant is completely untouched", async () => {
  // The whole point: one deleteMany missing its workspaceId filter would have
  // taken this with it.
  const after = await countsFor(survivor._id);
  assert.deepEqual(after, {
    obligations: 1, contracts: 1, processes: 1, steps: 1,
    templates: 1, reports: 1, logs: 1, users: 2,
  }, "deleting one workspace must not touch another");

  assert.equal(await Workspace.countDocuments({ _id: survivor._id }), 1);
  assert.equal(await User.countDocuments({ email: "admin@survivor.test" }), 1);
});

test("the result reports what was actually removed", async () => {
  // The counts are what the API hands back to the user as confirmation, so a
  // silently-zero report would hide a delete that did nothing.
  const fresh = await Workspace.create({
    adminId: new mongoose.Types.ObjectId(), adminEmail: "a@fresh.test",
    companyEmail: "co@fresh.test", companyName: "Fresh Pty Ltd", userName: "fresh-pty",
  });
  await populate(fresh._id, "fresh");

  const result = await workspaceService.deleteWorkspaceAndData(fresh._id);
  assert.equal(result.removed.obligations, 1);
  assert.equal(result.removed.contracts, 1);
  assert.equal(result.removed.users, 1);
  assert.equal(result.removed.activityLogs, 1);
});

test("deleting a workspace that does not exist is a no-op, not a crash", async () => {
  const result = await workspaceService.deleteWorkspaceAndData(new mongoose.Types.ObjectId());
  assert.equal(result, null, "a missing workspace should report nothing rather than throw");
});
