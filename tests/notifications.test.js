/**
 * In-app notifications.
 *
 * What matters: a user only ever sees and clears their own; a notification
 * never breaks the action that caused it; the workspace's "In-app
 * notifications" setting is honoured; and the events that should notify
 * someone actually do.
 *
 * Run with: npm run test:isolation
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

process.env.JWT_SECRET = process.env.JWT_SECRET || "notification-secret";

const realtime = require("../src/services/realtime");
const pushed = [];
realtime.setIo({ to: (room) => ({ emit: (event, payload) => pushed.push({ room, event, payload }) }) });

const { User } = require("../src/models");
const Workspace = require("../src/modules/workspace/model");
const { Notification } = require("../src/modules/notification/model");
const notifications = require("../src/modules/notification/service");
const { Process } = require("../src/modules/process/model");
const stepService = require("../src/modules/step/service");

let mongod;
let workspace, owner, admin, editor, outsider;

let seq = 0;
const make = (fields) =>
  User.create({
    name: `User ${seq}`, username: `n${(seq += 1)}`, password: "Password123",
    email: `n${seq}@acme.com`, isEmailVerified: true, ...fields,
  });

test.before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());

  owner = await make({ userType: "admin", role: "admin" });
  workspace = await Workspace.create({
    adminId: owner._id, companyEmail: "co@acme.com", companyName: "Acme", userName: "acme-n",
  });
  owner.workspaceId = workspace._id;
  await owner.save();
  admin = await make({ userType: "member", role: "admin", workspaceId: workspace._id });
  editor = await make({ userType: "member", role: "editor", workspaceId: workspace._id });
  outsider = await make({ userType: "admin", role: "admin", workspaceId: new mongoose.Types.ObjectId() });
});

test.after(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

const send = (overrides = {}) =>
  notifications.notifyUsers({
    workspaceId: workspace._id, userIds: [editor._id], type: "contract_signed", title: "Hello", ...overrides,
  });

// ─── Sending ─────────────────────────────────────────────────────────────────
test("a notification reaches its recipient and is pushed live when possible", async () => {
  pushed.length = 0;
  await send({ title: "Your contract was signed" });

  const { notifications: list, unread } = await notifications.listForUser(editor._id);
  assert.equal(list[0].title, "Your contract was signed");
  assert.equal(list[0].read, false);
  assert.ok(unread >= 1);
  assert.equal(pushed.at(-1).room, `user:${editor._id}`, "it must go to that user's room only");
});

test("the person who caused it is not notified about their own action", async () => {
  const before = await Notification.countDocuments({ userId: owner._id });
  await send({ userIds: [owner._id, editor._id], excludeUserId: owner._id });
  assert.equal(await Notification.countDocuments({ userId: owner._id }), before);
});

test("a recipient listed twice gets one notification", async () => {
  const before = await Notification.countDocuments({ userId: admin._id });
  await send({ userIds: [admin._id, admin._id, String(admin._id)] });
  assert.equal(await Notification.countDocuments({ userId: admin._id }), before + 1);
});

test("turning off in-app notifications for the workspace stops them", async () => {
  await Workspace.updateOne({ _id: workspace._id }, { $set: { "notificationPreferences.inApp": false } });
  const before = await Notification.countDocuments({});
  await send();
  assert.equal(await Notification.countDocuments({}), before, "the Company setting must actually do something");
  await Workspace.updateOne({ _id: workspace._id }, { $set: { "notificationPreferences.inApp": true } });
});

test("a failure to notify never throws into the action that caused it", async () => {
  const original = Notification.insertMany;
  Notification.insertMany = async () => { throw new Error("database unavailable"); };
  try {
    const result = await send();
    assert.deepEqual(result, [], "it should report nothing sent, not throw");
  } finally {
    Notification.insertMany = original;
  }
});

test("admins of the workspace are found, including invited admins, and nobody else", async () => {
  const ids = (await notifications.workspaceAdminIds(workspace._id)).map(String).sort();
  assert.deepEqual(ids, [String(owner._id), String(admin._id)].sort());
});

// ─── Privacy ─────────────────────────────────────────────────────────────────
test("nobody sees anyone else's notifications", async () => {
  await send({ userIds: [editor._id], title: "Editor only" });
  const { notifications: adminList } = await notifications.listForUser(admin._id);
  assert.ok(!adminList.some((n) => n.title === "Editor only"));
});

test("nobody can mark someone else's notification as read", async () => {
  const [n] = await send({ userIds: [editor._id], title: "Private" });
  await assert.rejects(() => notifications.markRead(outsider._id, n._id), /not found/);
  assert.equal((await Notification.findById(n._id)).readAt, null, "it must still be unread");
});

test("mark all read only touches your own", async () => {
  await send({ userIds: [editor._id, admin._id], title: "Both" });
  await notifications.markAllRead(editor._id);
  assert.equal(await notifications.unreadCount(editor._id), 0);
  assert.ok((await notifications.unreadCount(admin._id)) > 0, "another user's must stay unread");
});

test("a malformed id is a clean not-found, not a crash", async () => {
  await assert.rejects(() => notifications.markRead(editor._id, "not-an-id"), /not found/);
});

// ─── Triggers ────────────────────────────────────────────────────────────────
test("assigning steps notifies each assignee once, however many steps", async () => {
  const proc = await Process.create({ workspaceId: workspace._id, name: "Month-end close" });
  const before = await Notification.countDocuments({ userId: editor._id, type: "step_assigned" });

  await stepService.createStepsForProcess({
    workspaceId: workspace._id, processId: proc._id, processName: proc.name, actor: owner,
    steps: [
      { title: "Reconcile", sequenceNo: 1, assignee: editor._id },
      { title: "Review", sequenceNo: 2, assignee: editor._id },
      { title: "Sign off", sequenceNo: 3, assignee: null },
    ],
  });

  const after = await Notification.find({ userId: editor._id, type: "step_assigned" }).sort({ createdAt: -1 });
  assert.equal(after.length, before + 1, "two steps for one person should be one notification");
  assert.match(after[0].title, /2 steps assigned/);
  assert.equal(after[0].link, `/processes/${proc._id}`);
});

test("reassigning a step notifies the new assignee", async () => {
  const proc = await Process.create({ workspaceId: workspace._id, name: "Audit prep" });
  const [step] = await stepService.createStepsForProcess({
    workspaceId: workspace._id, processId: proc._id, processName: proc.name, actor: owner,
    steps: [{ title: "Collect invoices", sequenceNo: 1, assignee: null }],
  });

  await stepService.updateStepById({ stepId: step._id, workspaceId: workspace._id, payload: { assignee: admin._id }, actor: owner });

  const latest = await Notification.findOne({ userId: admin._id, type: "step_assigned" }).sort({ createdAt: -1 });
  assert.match(latest.title, /Collect invoices/);
});

test("an edit that leaves the assignee alone does not re-notify", async () => {
  const proc = await Process.create({ workspaceId: workspace._id, name: "Quiet" });
  const [step] = await stepService.createStepsForProcess({
    workspaceId: workspace._id, processId: proc._id, processName: proc.name, actor: owner,
    steps: [{ title: "Stable", sequenceNo: 1, assignee: editor._id }],
  });
  const before = await Notification.countDocuments({ userId: editor._id });

  await stepService.updateStepById({ stepId: step._id, workspaceId: workspace._id, payload: { notes: "typo fix" }, actor: owner });
  assert.equal(await Notification.countDocuments({ userId: editor._id }), before);
});
