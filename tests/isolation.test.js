/**
 * Workspace isolation tests.
 *
 * This is the product's core promise — "each company gets a completely
 * isolated, secure workspace" is on the signup page. Isolation currently rests
 * on every single query remembering to filter by workspaceId, which is exactly
 * the kind of thing a refactor drops silently. These tests run the real service
 * functions against a real (in-memory) MongoDB and assert that company B can
 * neither read nor modify company A's data.
 *
 * Run with: npm run test:isolation
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

process.env.JWT_SECRET = process.env.JWT_SECRET || "isolation-test-secret";

const { IrisReportingRequirement } = require("../src/modules/irisReporting/model");
const { Contract } = require("../src/modules/contract/model");
const { ReportTemplate } = require("../src/modules/reportTemplate/model");
const { Process } = require("../src/modules/process/model");
const { User } = require("../src/models");

const irisService = require("../src/modules/irisReporting/service");
const contractService = require("../src/modules/contract/service");
const reportTemplateService = require("../src/modules/reportTemplate/service");
const processService = require("../src/modules/process/service");
const userService = require("../src/modules/users/service");
const workspaceService = require("../src/modules/workspace/service");

const oid = () => new mongoose.Types.ObjectId();

// Two tenants that must never see each other.
const ACME = oid();
const GLOBEX = oid();

const acmeActor = { _id: oid(), name: "Acme Admin", email: "admin@acme.test", workspaceId: ACME };

let mongod;
let acmeObligation;
let acmeContract;
let acmeTemplate;
let acmeProcess;

test.before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());

  // Seed one record of every workspace-scoped type, for both tenants.
  [acmeObligation] = await IrisReportingRequirement.create([
    { workspaceId: ACME, title: "Acme annual statements", status: "planned" },
    { workspaceId: GLOBEX, title: "Globex annual statements", status: "planned" },
  ]);

  [acmeContract] = await Contract.create([
    { workspaceId: ACME, title: "Acme NDA", content: "secret acme terms", recipientName: "R", recipientEmail: "r@acme.test", ownerEmail: "o@acme.test", signToken: "acme-token" },
    { workspaceId: GLOBEX, title: "Globex NDA", content: "secret globex terms", recipientName: "R", recipientEmail: "r@globex.test", ownerEmail: "o@globex.test", signToken: "globex-token" },
  ]);

  [acmeTemplate] = await ReportTemplate.create([
    { workspaceId: ACME, name: "Acme template", fileType: "docx", fileName: "a.docx", url: "https://example.test/a.docx" },
    { workspaceId: GLOBEX, name: "Globex template", fileType: "docx", fileName: "g.docx", url: "https://example.test/g.docx" },
  ]);

  [acmeProcess] = await Process.create([
    { workspaceId: ACME, name: "Acme onboarding", status: "draft" },
    { workspaceId: GLOBEX, name: "Globex onboarding", status: "draft" },
  ]);

  await User.create([
    { workspaceId: ACME, name: "Acme Person", email: "person@acme.test", username: "acme_person", password: "hashed-placeholder", userType: "member", role: "editor" },
    { workspaceId: GLOBEX, name: "Globex Person", email: "person@globex.test", username: "globex_person", password: "hashed-placeholder", userType: "member", role: "editor" },
  ]);
});

test.after(async () => {
  await mongoose.disconnect();
  await mongod?.stop();
});

/** Asserts a cross-tenant call fails rather than silently succeeding. */
const assertDenied = async (label, fn) => {
  await assert.rejects(fn, (err) => {
    assert.equal(err.statusCode, 404, `${label} should be a clean 404, got ${err.statusCode}`);
    return true;
  }, `${label} — company B was able to reach company A's record`);
};

// ─── IRIS obligations ────────────────────────────────────────────────────────
test("IRIS: a workspace only sees its own obligations", async () => {
  const { requirements } = await irisService.getOverview({ workspaceId: ACME });
  const titles = requirements.map((r) => r.title);

  assert.ok(titles.includes("Acme annual statements"));
  assert.ok(
    !titles.some((t) => t.startsWith("Globex")),
    "Globex obligations leaked into Acme's overview"
  );
});

test("IRIS: cannot read, edit or delete another workspace's obligation", async () => {
  const id = acmeObligation._id;

  await assertDenied("updateRequirement", () =>
    irisService.updateRequirement({ workspaceId: GLOBEX, requirementId: id, payload: { title: "hijacked" }, actor: acmeActor })
  );
  await assertDenied("deleteRequirement", () =>
    irisService.deleteRequirement({ workspaceId: GLOBEX, requirementId: id, actor: acmeActor })
  );
  await assertDenied("addComment", () =>
    irisService.addComment({ workspaceId: GLOBEX, requirementId: id, text: "hi", actor: acmeActor })
  );

  const untouched = await IrisReportingRequirement.findById(id);
  assert.equal(untouched.title, "Acme annual statements", "the record was modified across tenants");
});

// ─── Contracts ───────────────────────────────────────────────────────────────
test("Contracts: listing and fetching are workspace-scoped", async () => {
  const list = await contractService.listContracts({ workspaceId: ACME });
  assert.equal(list.length, 1);
  assert.equal(list[0].title, "Acme NDA");

  await assertDenied("getContract", () =>
    contractService.getContract({ workspaceId: GLOBEX, contractId: acmeContract._id })
  );
  await assertDenied("deleteContract", () =>
    contractService.deleteContract({ workspaceId: GLOBEX, contractId: acmeContract._id, actor: acmeActor })
  );

  assert.ok(await Contract.findById(acmeContract._id), "contract was deleted across tenants");
});

// ─── Report templates ────────────────────────────────────────────────────────
test("Report templates: listing and deletion are workspace-scoped", async () => {
  const list = await reportTemplateService.listTemplates({ workspaceId: ACME });
  assert.equal(list.length, 1);
  assert.equal(list[0].name, "Acme template");

  await assertDenied("deleteTemplate", () =>
    reportTemplateService.deleteTemplate({ workspaceId: GLOBEX, templateId: acmeTemplate._id })
  );
  assert.ok(await ReportTemplate.findById(acmeTemplate._id), "template was deleted across tenants");
});

test("Report templates: cannot generate a report from another workspace's template", async () => {
  await assertDenied("generateFromTemplate", () =>
    reportTemplateService.generateFromTemplate({
      workspaceId: GLOBEX,
      templateId: acmeTemplate._id,
      obligationIds: [acmeObligation._id],
    })
  );
});

// ─── Processes ───────────────────────────────────────────────────────────────
test("Processes: listing and fetching are workspace-scoped", async () => {
  const { processes } = await processService.listWorkspaceProcesses({ workspaceId: ACME, query: {} });
  assert.equal(processes.length, 1);
  assert.equal(processes[0].name, "Acme onboarding");

  await assertDenied("getProcessById", () =>
    processService.getProcessById({ workspaceId: GLOBEX, processId: acmeProcess._id })
  );
  await assertDenied("deleteProcessById", () =>
    processService.deleteProcessById({ workspaceId: GLOBEX, processId: acmeProcess._id, actor: acmeActor })
  );
});

// ─── Users ───────────────────────────────────────────────────────────────────
test("Users: a workspace only lists its own members", async () => {
  const { users } = await userService.getUsersByWorkspaceId({ workspaceId: ACME });
  assert.ok(users.length >= 1);
  assert.ok(
    users.every((u) => String(u.workspaceId) === String(ACME)),
    "a member from another workspace appeared in the list"
  );
  assert.ok(!users.some((u) => u.email === "person@globex.test"));
});

test("Users: passwords and reset tokens are never returned", async () => {
  const { users } = await userService.getUsersByWorkspaceId({ workspaceId: ACME });
  for (const user of users) {
    assert.equal(user.password, undefined, "password hash leaked in the member list");
    assert.equal(user.resetToken, undefined, "reset token leaked in the member list");
  }
});

// ─── Workspace overview / storage ────────────────────────────────────────────
test("Workspace overview counts only its own workspace", async () => {
  const overview = await workspaceService.getWorkspaceOverview({ workspaceId: ACME });
  assert.equal(overview.members.total, 1, "member count included another workspace");
  assert.ok(overview.storage, "storage usage missing from overview");
  assert.equal(typeof overview.storage.usedBytes, "number");
});

test("Storage usage does not count another workspace's files", async () => {
  await IrisReportingRequirement.updateOne(
    { workspaceId: GLOBEX },
    { $push: { evidenceFiles: { _id: oid(), fileName: "big.pdf", fileType: "application/pdf", fileSize: 5_000_000, url: "https://example.test/big.pdf" } } }
  );

  const acme = await workspaceService.getWorkspaceOverview({ workspaceId: ACME });
  assert.equal(acme.storage.usedBytes, 0, "Globex's 5MB file was counted against Acme");

  const globex = await workspaceService.getWorkspaceOverview({ workspaceId: GLOBEX });
  assert.equal(globex.storage.usedBytes, 5_000_000, "Globex's own file was not counted");
});

// ─── Public contract signing ─────────────────────────────────────────────────
test("Contract signing links resolve only their own contract", async () => {
  const acme = await contractService.getPublicContract({ token: "acme-token" });
  assert.equal(acme.title, "Acme NDA");

  const globex = await contractService.getPublicContract({ token: "globex-token" });
  assert.equal(globex.title, "Globex NDA");

  await assert.rejects(
    () => contractService.getPublicContract({ token: "made-up-token" }),
    (err) => err.statusCode === 404,
    "an unknown signing token must not resolve to a contract"
  );
});
