const mongoose = require("mongoose");

const NOTIFICATION_TYPES = [
  "contract_signed",
  "invitation_accepted",
  "approval_decided",
  "obligation_assigned",
  "step_assigned",
  "due_date_reminder",
];

const notificationSchema = new mongoose.Schema(
  {
    workspaceId: { type: mongoose.Schema.Types.ObjectId, ref: "Workspace", required: true },
    // The recipient. Every read and write is filtered by this, so one user can
    // never see or clear another's notifications.
    userId:  { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    type:    { type: String, enum: NOTIFICATION_TYPES, required: true },
    title:   { type: String, required: true, trim: true },
    message: { type: String, default: "", trim: true },
    // Where clicking it takes the user, as an in-app path.
    link:    { type: String, default: "" },
    readAt:  { type: Date, default: null },
  },
  { timestamps: true }
);

// The bell asks for "my latest" and "how many unread" on every page.
notificationSchema.index({ userId: 1, createdAt: -1 });
notificationSchema.index({ userId: 1, readAt: 1 });
// Notifications are prompts, not records — the activity log is the record.
// Removing them after 90 days keeps the collection from growing forever.
notificationSchema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });

const Notification = mongoose.model("Notification", notificationSchema);

module.exports = { Notification, NOTIFICATION_TYPES };
