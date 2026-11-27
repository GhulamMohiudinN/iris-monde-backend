/**
 * Workspace permissions.
 *
 * Three faults, found while tracing why a client's own login lacked invoices,
 * contracts and evidence access.
 *
 * The menu decided access by `role` and the server by `userType`, so a teammate
 * invited as Admin saw every admin feature and was refused by each of them.
 *
 * Deleting a user took any id and deleted it, with no check that the target was
 * in the caller's workspace — an admin of one company could delete another
 * company's users, their own workspace owner, or the platform operator.
 *
 * Once role carries real permission, a user able to set their own role is a
 * Viewer able to make themselves an Admin — and the self-update endpoint
 * accepted role. That is closed too.
 *
 * Run with: npm run test:isolation
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

process.env.JWT_SECRET = process.env.JWT_SECRET || "permissions-secret";

const { User } = require("../src/models");
const userService = require("../src/modules/users/service");
const userValidation = require("../src/modules/users/valadition");
const { isSuperAdmin, isWorkspaceOwner, isWorkspaceAdmin } = require("../src/middlewares/auth");

let mongod;
const ACME = new mongoose.Types.ObjectId();
const GLOBEX = new mongoose.Types.ObjectId();
let acmeOwner, acmeAdmin, acmeEditor, globexOwner, globexMember, operator;

const runGuard = (guard, user) =>
  new Promise((resolve) => {
    const req = { user };
    const res = {
      status(code) { this._code = code; return this; },
      send() { resolve({ allowed: false, code: this._code }); },
    };
    guard()(req, res, (err) => resolve(err ? { allowed: false, err } : { allowed: true }));
  });

let seq = 0;
const make = (fields) =>
  User.create({
    name: "U", username: `u${(seq += 1)}`, password: "Password123",
    email: `u${seq}@acme.com`, isEmailVerified: true, ...fields,
  });

test.before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());

  acmeOwner    = await make({ userType: "admin",  role: "admin",  workspaceId: ACME });
  acmeAdmin    = await make({ userType: "member", role: "admin",  workspaceId: ACME });
  acmeEditor   = await make({ userType: "member", role: "editor", workspaceId: ACME });
  globexOwner  = await make({ userType: "admin",  role: "admin",  workspaceId: GLOBEX });
  globexMember = await make({ userType: "member", role: "viewer", workspaceId: GLOBEX });
  operator     = await make({ userType: "owner",  role: "admin",  workspaceId: null });
});

test.after(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

// ─── Who administers a workspace ─────────────────────────────────────────────
test("a teammate invited as Admin can use admin features", async () => {
  assert.equal(isWorkspaceAdmin(acmeAdmin), true);
  assert.deepEqual(await runGuard(isSuperAdmin, acmeAdmin), { allowed: true },
    "invited as Admin must mean admin — the menu already shows them every admin feature");
});

test("the workspace owner still can", async () => {
  assert.deepEqual(await runGuard(isSuperAdmin, acmeOwner), { allowed: true });
});

test("editors and viewers cannot", async () => {
  for (const user of [acmeEditor, globexMember]) {
    const result = await runGuard(isSuperAdmin, user);
    assert.equal(result.allowed, false, `${user.role} must not pass the admin check`);
    assert.equal(result.code, 403);
  }
});

test("a platform operator is still not a workspace admin", async () => {
  assert.equal((await runGuard(isSuperAdmin, operator)).allowed, false,
    "an operator belongs to no workspace, so workspace routes must keep refusing them");
});

test("a member claiming the admin role with no workspace is refused", async () => {
  assert.equal(isWorkspaceAdmin({ userType: "member", role: "admin", workspaceId: null }), false);
});

// ─── What only the owner may do ──────────────────────────────────────────────
test("only the owner may create or delete the workspace", async () => {
  assert.deepEqual(await runGuard(isWorkspaceOwner, acmeOwner), { allowed: true });

  const invitedAdmin = await runGuard(isWorkspaceOwner, acmeAdmin);
  assert.equal(invitedAdmin.allowed, false,
    "an admin the owner invited must not be able to delete the workspace out from under them");
  assert.equal(invitedAdmin.code, 403);
});

// ─── Deleting users ──────────────────────────────────────────────────────────
test("an admin cannot delete a user in another company", async () => {
  await assert.rejects(
    () => userService.deleteUserById(globexMember._id, acmeOwner),
    /User not found/,
    "the reply must not confirm the user exists elsewhere"
  );
  assert.equal(await User.countDocuments({ _id: globexMember._id }), 1, "the other company's user must survive");
});

test("an admin cannot delete another company's owner", async () => {
  await assert.rejects(() => userService.deleteUserById(globexOwner._id, acmeAdmin), /User not found/);
  assert.equal(await User.countDocuments({ _id: globexOwner._id }), 1);
});

test("nobody can delete the platform operator through this route", async () => {
  await assert.rejects(() => userService.deleteUserById(operator._id, acmeOwner), /User not found/);
  assert.equal(await User.countDocuments({ _id: operator._id }), 1);
});

test("an invited admin cannot remove the workspace owner", async () => {
  await assert.rejects(() => userService.deleteUserById(acmeOwner._id, acmeAdmin), /owner of a workspace cannot be removed/);
  assert.equal(await User.countDocuments({ _id: acmeOwner._id }), 1);
});

test("an admin cannot remove themselves", async () => {
  await assert.rejects(() => userService.deleteUserById(acmeAdmin._id, acmeAdmin), /cannot remove yourself/);
});

test("removing a member of your own workspace still works", async () => {
  const leaving = await make({ userType: "member", role: "viewer", workspaceId: ACME });
  await userService.deleteUserById(leaving._id, acmeOwner);
  assert.equal(await User.countDocuments({ _id: leaving._id }), 0);
});

// ─── Changing your own role ──────────────────────────────────────────────────
test("a viewer cannot make themselves an admin", async () => {
  const viewer = await make({ userType: "member", role: "viewer", workspaceId: ACME });

  await assert.rejects(
    () => userService.updateUserById(viewer._id, { role: "admin" }),
    /can only be changed by a workspace admin/
  );
  assert.equal((await User.findById(viewer._id)).role, "viewer");
});

test("the profile endpoint does not even accept a role", () => {
  const { value } = userValidation.validateUpdateUserInputs({ name: "Someone", role: "admin" });
  assert.equal(value.role, undefined, "role must be stripped before it reaches the service");
});

test("a profile update that repeats the current role is not refused", async () => {
  // Clients that echo the role back unchanged must not start failing.
  await userService.updateUserById(acmeEditor._id, { name: "Ed Itor", role: "editor" });
  assert.equal((await User.findById(acmeEditor._id)).name, "Ed Itor");
});

test("an admin can still change a member's role, the proper way", async () => {
  const member = await make({ userType: "member", role: "viewer", workspaceId: ACME });
  await userService.updateTeamMemberBySuperAdmin({
    adminUser: acmeAdmin, memberId: member._id, payload: { name: "Promoted", role: "editor" },
  });
  assert.equal((await User.findById(member._id)).role, "editor");
});

test("an admin cannot change a member of another company", async () => {
  await assert.rejects(
    () => userService.updateTeamMemberBySuperAdmin({
      adminUser: acmeOwner, memberId: globexMember._id, payload: { name: "Hijacked", role: "admin" },
    }),
    /only update members from your workspace/
  );
  assert.equal((await User.findById(globexMember._id)).role, "viewer");
});

// ─── Role matrix ─────────────────────────────────────────────────────────────
// The invite screen promises: Admin — full access; Editor — create and edit
// processes, not manage users; Viewer — read-only access to all processes.
const { effectiveRole, requireRole } = require("../src/middlewares/auth");

test("each account resolves to the right workspace role", () => {
  assert.equal(effectiveRole(acmeOwner), "admin");
  assert.equal(effectiveRole(acmeAdmin), "admin");
  assert.equal(effectiveRole(acmeEditor), "editor");
  assert.equal(effectiveRole(globexMember), "viewer");
  assert.equal(effectiveRole(operator), null, "an operator has no workspace role");
});

test("editors can create and edit processes; viewers cannot", async () => {
  const editGuard = () => requireRole("admin", "editor");
  assert.deepEqual(await runGuard(editGuard, acmeEditor), { allowed: true });
  assert.deepEqual(await runGuard(editGuard, acmeOwner), { allowed: true });

  const viewer = await runGuard(editGuard, globexMember);
  assert.equal(viewer.allowed, false, "a viewer is read-only");
  assert.equal(viewer.code, 403);
});

test("all three roles can view processes; an operator cannot", async () => {
  const viewGuard = () => requireRole("admin", "editor", "viewer");
  for (const user of [acmeOwner, acmeAdmin, acmeEditor, globexMember]) {
    assert.deepEqual(await runGuard(viewGuard, user), { allowed: true }, `${user.role} should see processes`);
  }
  assert.equal((await runGuard(viewGuard, operator)).allowed, false);
});

test("editors still cannot reach admin-only features", async () => {
  // Users, company settings, IRIS, invoices, contracts and logs stay admin-only.
  const result = await runGuard(isSuperAdmin, acmeEditor);
  assert.equal(result.allowed, false);
  assert.equal(result.code, 403);
});

test("an unknown or missing role grants nothing", () => {
  assert.equal(effectiveRole({ userType: "member", role: "superuser", workspaceId: ACME }), null);
  assert.equal(effectiveRole({ userType: "member", workspaceId: ACME }), null);
  assert.equal(effectiveRole(null), null);
});
