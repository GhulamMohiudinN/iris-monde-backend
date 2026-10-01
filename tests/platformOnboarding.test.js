/**
 * Invitation-only onboarding.
 *
 * Public sign-up is closed, so the platform-operator role is now the only way
 * a client company comes into existence. That makes it the most privileged
 * thing in the system: it creates tenants. These tests run the real service
 * functions and the real middleware against a real (in-memory) MongoDB and
 * assert the two properties that matter — that only an operator can create a
 * company, and that the role cannot be reached from inside the application.
 *
 * Run with: npm run test:isolation
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

process.env.JWT_SECRET = process.env.JWT_SECRET || "platform-test-secret";

const { User, Workspace } = require("../src/models");
const platformService = require("../src/modules/platform/service");
const userService = require("../src/modules/users/service");
const { isPlatformOwner, isSuperAdmin } = require("../src/middlewares/auth");
const emailService = require("../src/services/email.service");

let mongod;
let owner;
const sentEmails = [];

// The invitation email is the only channel the new administrator has, so the
// tests assert on what would have been sent rather than stubbing it away.
// failNextEmail simulates an SMTP outage for a single send.
let failNextEmail = false;
emailService.sendAddMemberInvitation = async (args) => {
  if (failNextEmail) {
    failNextEmail = false;
    throw new Error("connect ECONNREFUSED 127.0.0.1:587");
  }
  sentEmails.push(args);
};

/** Runs a guard the way Express does and reports what it decided. */
const runGuard = (guard, user) =>
  new Promise((resolve) => {
    const req = { user };
    const res = {
      status(code) { this._code = code; return this; },
      send(body) { resolve({ allowed: false, code: this._code, body }); },
    };
    guard()(req, res, (err) => resolve(err ? { allowed: false, err } : { allowed: true }));
  });

test.before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());

  owner = await User.create({
    name: "Platform Operator",
    email: "operator@reseauxaccess.test",
    username: "operator",
    password: "Placeholder123",
    userType: "owner",
    isEmailVerified: true,
    workspaceId: null,
  });
});

test.after(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

// ─── Creating a company ──────────────────────────────────────────────────────
test("an operator creates a company and its administrator is invited, not activated", async () => {
  const before = sentEmails.length;

  const result = await platformService.createClientCompany({
    owner,
    payload: {
      companyName: "Acme Pty Ltd",
      adminName: "Jane Smith",
      adminEmail: "jane@acme.test",
      industry: "Financial Services",
    },
  });

  assert.equal(result.company.companyName, "Acme Pty Ltd");
  assert.ok(result.company.userName, "a workspace code should be generated");

  const admin = await User.findById(result.administrator.id);
  assert.equal(admin.userType, "admin");
  assert.equal(String(admin.workspaceId), String(result.company.id), "admin must be attached to the new workspace");

  // The whole point of invitation-only: creating the company must not create a
  // usable account. Until the invitation is accepted it cannot be signed into.
  assert.equal(admin.isEmailVerified, false, "the administrator must not start verified");
  assert.equal(admin.invitationStatus, "pending");
  assert.ok(admin.resetToken, "an invitation token must be issued");

  assert.equal(sentEmails.length, before + 1, "exactly one invitation should be sent");
  assert.equal(sentEmails.at(-1).to, "jane@acme.test");
});

test("the invitation lasts long enough to be useful", async () => {
  const admin = await User.findOne({ email: "jane@acme.test" });
  const days = (admin.resetTokenExpiry - Date.now()) / (24 * 60 * 60 * 1000);
  assert.ok(days > 6, "invitation should last about a week, got " + days.toFixed(1) + " days");
});

test("the new administrator can accept their own invitation", async () => {
  const admin = await User.findOne({ email: "jane@acme.test" });

  // Regression guard: acceptInvitationByToken used to match userType 'member'
  // only, which left a company's first administrator permanently locked out of
  // the account that had just been created for them.
  const accepted = await userService.acceptInvitationByToken({
    token: admin.resetToken,
    password: "RealPassword123",
  });

  assert.equal(accepted.invitationStatus, "accepted");
  assert.equal(accepted.isEmailVerified, true);
  assert.equal(String(accepted.workspaceId), String(admin.workspaceId), "they must land in their own workspace");

  const reloaded = await User.findById(admin._id);
  assert.equal(reloaded.resetToken, "", "the invitation token must be spent");
});

test("a company is created with its default templates, not an empty shell", async () => {
  const Template = require("../src/modules/template/model");
  const model = Template.Template || Template;
  const workspace = await Workspace.findOne({ companyName: "Acme Pty Ltd" });
  const count = await model.countDocuments({ workspaceId: workspace._id });
  assert.ok(count > 0, "createNewWorkspace should have seeded the default templates");
});

// ─── Rejecting bad input ─────────────────────────────────────────────────────
test("an email that already has an account is refused", async () => {
  await assert.rejects(
    () => platformService.createClientCompany({
      owner,
      payload: { companyName: "Another Co", adminName: "Jane", adminEmail: "jane@acme.test" },
    }),
    /already belongs to an account/i
  );
});

test("a duplicate company name is refused, ignoring case", async () => {
  await assert.rejects(
    () => platformService.createClientCompany({
      owner,
      payload: { companyName: "ACME PTY LTD", adminName: "Other", adminEmail: "other@acme.test" },
    }),
    /already exists/i
  );
});

test("a failed company creation leaves no orphaned user behind", async () => {
  const before = await User.countDocuments({});

  // Force createNewWorkspace to throw after the administrator has already been
  // written, which is the window where a half-created user could be stranded.
  const WorkspaceModel = mongoose.model("Workspace");
  const original = WorkspaceModel.create.bind(WorkspaceModel);
  WorkspaceModel.create = async () => { throw new Error("forced failure"); };

  await assert.rejects(
    () => platformService.createClientCompany({
      owner,
      payload: { companyName: "Rollback Co", adminName: "Rollback", adminEmail: "rollback@test.test" },
    }),
    /forced failure/
  );

  WorkspaceModel.create = original;

  const after = await User.countDocuments({});
  assert.equal(after, before, "the half-created administrator must be cleaned up");
  assert.equal(
    await User.countDocuments({ email: "rollback@test.test" }), 0,
    "the email must be reusable after a failed attempt"
  );
});

// ─── A failed invitation must not destroy the company ────────────────────────
// Found in live testing: the email send threw, the whole request returned 500,
// but the company and its administrator had already been written. The operator
// was told it failed, could not create it again ("already exists"), and nothing
// in the product showed the orphan. The company is the durable thing; the
// email is a notification, so a send failure is reported and retried.
test("a company survives the invitation email failing", async () => {
  failNextEmail = true;

  const result = await platformService.createClientCompany({
    owner,
    payload: { companyName: "Outage Co", adminName: "Pat", adminEmail: "pat@outage.test" },
  });

  assert.equal(result.invitationSent, false, "the failure must be reported, not swallowed");
  assert.ok(result.invitationError, "the reason should be carried back");
  assert.ok(result.company.id, "the company must still have been created");

  const companies = await platformService.listClientCompanies();
  assert.ok(
    companies.some((c) => c.companyName === "Outage Co"),
    "the company must be visible in the console so the operator can act on it"
  );
});

test("resending issues a fresh token, so an expired invitation is recoverable", async () => {
  const before = await User.findOne({ email: "pat@outage.test" });
  const company = await Workspace.findOne({ companyName: "Outage Co" });

  // Expire it, exactly as a week-old unopened invitation would be.
  before.resetTokenExpiry = new Date(Date.now() - 1000);
  await before.save();

  const result = await platformService.resendCompanyInvitation({ owner, companyId: company._id });
  assert.equal(result.email, "pat@outage.test");

  const after = await User.findOne({ email: "pat@outage.test" });
  assert.notEqual(after.resetToken, before.resetToken, "a new token must be minted");
  assert.ok(after.resetTokenExpiry > new Date(), "the new invitation must not already be expired");
  assert.equal(sentEmails.at(-1).to, "pat@outage.test");

  // And the new token actually works.
  const accepted = await userService.acceptInvitationByToken({
    token: after.resetToken,
    password: "RecoveredPass123",
  });
  assert.equal(accepted.invitationStatus, "accepted");
});

test("resending to someone who already accepted is refused", async () => {
  const company = await Workspace.findOne({ companyName: "Outage Co" });
  await assert.rejects(
    () => platformService.resendCompanyInvitation({ owner, companyId: company._id }),
    /already accepted/i,
    "re-inviting an active administrator would reset the account they are using"
  );
});

test("resending for an unknown company is a clean 404, not a crash", async () => {
  await assert.rejects(
    () => platformService.resendCompanyInvitation({ owner, companyId: new mongoose.Types.ObjectId() }),
    /Company not found/i
  );
});

// ─── Who is allowed in ───────────────────────────────────────────────────────
test("only a platform operator passes the platform guard", async () => {
  assert.deepEqual(await runGuard(isPlatformOwner, { userType: "owner" }), { allowed: true });

  for (const userType of ["admin", "member"]) {
    const result = await runGuard(isPlatformOwner, { userType });
    assert.equal(result.allowed, false, userType + " must not reach platform routes");
    assert.equal(result.code, 403);
  }
});

test("the operator role is not a superset of the workspace admin role", async () => {
  // Deliberate: an operator has no workspaceId, so letting them through
  // workspace routes would run every workspace-scoped query with undefined.
  const result = await runGuard(isSuperAdmin, { userType: "owner" });
  assert.equal(result.allowed, false, "an operator must not reach workspace-scoped routes");
  assert.equal(result.code, 403);

  assert.deepEqual(await runGuard(isSuperAdmin, { userType: "admin" }), { allowed: true });
});

test("no request can turn a user into a platform operator", async () => {
  const admin = await User.findOne({ email: "jane@acme.test" });

  // updateUserById assigns whatever it is handed. The routes that call it strip
  // unknown fields with Joi, but that is one forgotten schema away from a
  // privilege escalation, so the refusal is asserted at the service itself.
  await assert.rejects(
    () => userService.updateUserById(admin._id, { userType: "owner", role: "admin" }),
    /userType cannot be changed/i,
    "granting the platform role through a user update must be refused outright"
  );

  const reloaded = await User.findById(admin._id);
  assert.equal(reloaded.userType, "admin", "the user must be left untouched");

  // A no-op userType must still pass, or ordinary profile updates that echo the
  // current value back would start failing.
  await userService.updateUserById(admin._id, { userType: "admin", name: "Jane S" });
  assert.equal((await User.findById(admin._id)).name, "Jane S");
});

test("the route that updates a profile cannot carry userType through", () => {
  // Defence in depth: the service refuses it, and the schema never passes it on.
  const userValidation = require("../src/modules/users/valadition");
  const { value } = userValidation.validateUpdateUserInputs({
    name: "Someone", role: "admin", userType: "owner",
  });
  assert.equal(value.userType, undefined, "userType must be stripped before it reaches the service");
});

// ─── Public sign-up ──────────────────────────────────────────────────────────
test("public sign-up is closed by default and can be reopened by configuration", () => {
  const configPath = require.resolve("../src/config/config");

  delete process.env.ALLOW_PUBLIC_SIGNUP;
  delete require.cache[configPath];
  assert.equal(
    require("../src/config/config").allowPublicSignup, false,
    "sign-up must be closed unless explicitly enabled"
  );

  process.env.ALLOW_PUBLIC_SIGNUP = "true";
  delete require.cache[configPath];
  assert.equal(require("../src/config/config").allowPublicSignup, true);

  delete process.env.ALLOW_PUBLIC_SIGNUP;
  delete require.cache[configPath];
});

// ─── Listing ─────────────────────────────────────────────────────────────────
test("the company list reports administrator state so a dead invitation is visible", async () => {
  await platformService.createClientCompany({
    owner,
    payload: { companyName: "Globex Ltd", adminName: "Bob", adminEmail: "bob@globex.test" },
  });

  const companies = await platformService.listClientCompanies();
  const names = companies.map((c) => c.companyName);
  assert.ok(names.includes("Acme Pty Ltd") && names.includes("Globex Ltd"));

  const globex = companies.find((c) => c.companyName === "Globex Ltd");
  assert.equal(
    globex.administrator.invitationStatus, "pending",
    "an unaccepted invitation must be visible, not silently forgotten"
  );

  const acme = companies.find((c) => c.companyName === "Acme Pty Ltd");
  assert.equal(acme.administrator.invitationStatus, "accepted");
  assert.ok(acme.userCount >= 1);
});
