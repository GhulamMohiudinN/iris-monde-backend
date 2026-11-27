const mongoose = require("mongoose");
const httpStatus = require("http-status");
const ApiError = require("../../utils/ApiError");
const { Notification } = require("./model");
const { emitToUser } = require("../../services/realtime");

const LIST_LIMIT = 30;

const toPublic = (n) => ({
  id:        n._id,
  type:      n.type,
  title:     n.title,
  message:   n.message,
  link:      n.link,
  read:      !!n.readAt,
  createdAt: n.createdAt,
});

/**
 * Sends a notification to specific users of a workspace.
 *
 * Never throws. Notifications ride along on other actions — a contract being
 * signed, an approval being decided — and a failure to notify must never undo
 * or fail the action itself. Problems are logged and swallowed.
 *
 * Honours the workspace's "In-app notifications" setting on the Company page,
 * which until now was saved but changed nothing.
 */
const notifyUsers = async ({ workspaceId, userIds, type, title, message = "", link = "", excludeUserId }) => {
  try {
    if (!workspaceId) return [];

    // Required here rather than at the top: the workspace module requires
    // services that in turn notify, and a top-level require would be circular.
    const Workspace = require("../workspace/model");
    const workspace = await Workspace.findById(workspaceId).select("notificationPreferences").lean();
    if (workspace?.notificationPreferences?.inApp === false) return [];

    const recipients = [...new Set((userIds || []).filter(Boolean).map(String))]
      .filter((id) => id !== String(excludeUserId || ""))
      .filter((id) => mongoose.Types.ObjectId.isValid(id));
    if (!recipients.length) return [];

    const created = await Notification.insertMany(
      recipients.map((userId) => ({ workspaceId, userId, type, title, message, link }))
    );

    for (const n of created) emitToUser(n.userId, "notification", toPublic(n));
    return created;
  } catch (err) {
    console.error(`[notification] could not send "${type}": ${err.message}`);
    return [];
  }
};

/** Everyone who administers the workspace — its owner and any member invited as Admin. */
const workspaceAdminIds = async (workspaceId) => {
  const { User } = require("../../models");
  const admins = await User.find({
    workspaceId,
    $or: [{ userType: "admin" }, { userType: "member", role: "admin" }],
  }).select("_id").lean();
  return admins.map((a) => a._id);
};

const notifyWorkspaceAdmins = async ({ workspaceId, ...rest }) => {
  try {
    return notifyUsers({ workspaceId, userIds: await workspaceAdminIds(workspaceId), ...rest });
  } catch (err) {
    console.error(`[notification] could not resolve admins: ${err.message}`);
    return [];
  }
};

/** A user in the workspace, found by email — obligations store their owner that way. */
const userIdByEmail = async (workspaceId, email) => {
  if (!email) return null;
  const { User } = require("../../models");
  const user = await User.findOne({ workspaceId, email: String(email).trim().toLowerCase() }).select("_id").lean();
  return user?._id || null;
};

// ─── Reading and clearing — always the caller's own ──────────────────────────
const listForUser = async (userId) => {
  const items = await Notification.find({ userId }).sort({ createdAt: -1 }).limit(LIST_LIMIT).lean();
  const unread = await Notification.countDocuments({ userId, readAt: null });
  return { notifications: items.map(toPublic), unread };
};

const unreadCount = async (userId) => Notification.countDocuments({ userId, readAt: null });

const markRead = async (userId, notificationId) => {
  if (!mongoose.Types.ObjectId.isValid(notificationId)) {
    throw new ApiError(httpStatus.NOT_FOUND, "Notification not found");
  }
  // Filtered by the caller as well as the id, so a guessed id belonging to
  // someone else simply is not found.
  const n = await Notification.findOneAndUpdate(
    { _id: notificationId, userId },
    { $set: { readAt: new Date() } },
    { new: true }
  ).lean();
  if (!n) throw new ApiError(httpStatus.NOT_FOUND, "Notification not found");
  return toPublic(n);
};

const markAllRead = async (userId) => {
  const result = await Notification.updateMany({ userId, readAt: null }, { $set: { readAt: new Date() } });
  return { updated: result.modifiedCount };
};

module.exports = {
  notifyUsers,
  notifyWorkspaceAdmins,
  workspaceAdminIds,
  userIdByEmail,
  listForUser,
  unreadCount,
  markRead,
  markAllRead,
};
