const mongoose = require("mongoose");

const IRIS_STATUS   = ["planned", "in_progress", "completed", "blocked"];
const APPROVAL_STATUS = ["pending", "approved", "rejected", "not_required"];
const MATERIALITY   = ["Low", "Standard", "Medium", "High", "Critical"];
const OBLIGATION_TYPE = [
  "statutory_reporting", "compliance_review", "disclosure_pack",
  "audit_evidence", "reporting", "approval", "other",
];

// ─── Evidence File ────────────────────────────────────────────────────────────
const evidenceFileSchema = new mongoose.Schema(
  {
    _id:        { type: mongoose.Schema.Types.ObjectId },
    fileName:   { type: String, required: true, trim: true },
    fileType:   { type: String, required: true },
    fileSize:   { type: Number, required: true },
    url:        { type: String, required: true },
    publicId:   { type: String, default: "" },      // Cloudinary asset id — empty in dev fallback
    uploadedBy: { type: String, default: "System" },
    uploadedAt: { type: Date,   default: Date.now },
  },
  { _id: true }
);

// ─── Comment / Note ───────────────────────────────────────────────────────────
const commentSchema = new mongoose.Schema(
  {
    _id:       { type: mongoose.Schema.Types.ObjectId },
    text:      { type: String, required: true, trim: true },
    authorId:  { type: String },
    authorName:{ type: String, default: "System" },
    createdAt: { type: Date,   default: Date.now },
  },
  { _id: true }
);

// ─── Approval Step ────────────────────────────────────────────────────────────
const approvalStepSchema = new mongoose.Schema(
  {
    _id:         { type: mongoose.Schema.Types.ObjectId },
    stepName:    { type: String, required: true },   // e.g. "CFO Review", "Secretary Sign-off"
    assignedTo:  { type: String },                   // name or email
    status:      { type: String, enum: APPROVAL_STATUS, default: "pending" },
    decidedAt:   { type: Date, default: null },
    decidedBy:   { type: String },
    notes:       { type: String, default: "" },
    order:       { type: Number, default: 1 },
  },
  { _id: true }
);

// ─── Main Requirement ─────────────────────────────────────────────────────────
const irisRequirementSchema = new mongoose.Schema(
  {
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
      index: true,
    },

    // Core obligation fields
    title:          { type: String, required: true, trim: true },
    source:         { type: String, default: "Client requirement", trim: true },
    legislationRef: { type: String, default: "", trim: true }, // e.g. "SD 4.2.1(a)"
    category:       { type: String, default: "Reporting", trim: true },
    obligationType: { type: String, enum: OBLIGATION_TYPE, default: "reporting" },
    status:         { type: String, enum: IRIS_STATUS, default: "planned" },
    dueDate:        { type: Date, default: null },
    owner:          { type: String, default: "Operations", trim: true },
    // Set only when Owner is picked from the real workspace-member list —
    // needed to actually send due-date reminder emails. Free-typed owners
    // (e.g. a role title) leave this empty and simply don't get reminders.
    ownerEmail:      { type: String, default: "", trim: true, lowercase: true },
    reportType:     { type: String, default: "Statutory report", trim: true },
    materiality:    { type: String, enum: MATERIALITY, default: "Standard" },
    approvalRequired: { type: Boolean, default: false },
    details:        { type: String, default: "", trim: true },

    // Due-date reminder tracking — set once a reminder email has gone out,
    // so the daily cron never emails the same owner twice for one obligation.
    reminderSentAt: { type: Date, default: null },

    // Evidence
    evidenceRequired: [{ type: String, trim: true }],
    evidenceFiles:    [evidenceFileSchema],

    // Approval workflow — ordered steps that must all be approved
    approvalSteps: [approvalStepSchema],
    approvalStatus: { type: String, enum: APPROVAL_STATUS, default: "not_required" },
    approvedAt:    { type: Date, default: null },

    // Comments / reviewer notes
    comments: [commentSchema],

    // Legislation version tracking
    legislationVersion: { type: String, default: "" }, // e.g. "FMA 1994 — 2018 Amendment"
    ruleVersion:        { type: String, default: "1.0" },

    // Reporting period
    reportingPeriod: { type: String, default: "" }, // e.g. "FY2025-26"
  },
  { timestamps: true }
);

/**
 * Derives the overall approval state from the individual steps.
 *
 * Exported because inserts that bypass the pre-save hook — notably
 * `insertMany`, which Mongoose does not run `pre("save")` for — still have to
 * set this. When seeding skipped it, obligations that required approval were
 * stored as "not_required", so they never appeared in the Approvals tab and
 * the Approval column claimed no approval was needed.
 *
 * An obligation that requires approval is never "not_required", even with no
 * steps defined yet: it genuinely is awaiting approval, and something has to
 * be added before it can be satisfied. Rule 6 warns about the missing steps.
 */
const deriveApprovalStatus = ({ approvalRequired, approvalSteps } = {}) => {
  if (!approvalRequired) return "not_required";
  const steps = approvalSteps || [];
  if (steps.every((s) => s.status === "approved") && steps.length) return "approved";
  if (steps.some((s) => s.status === "rejected")) return "rejected";
  return "pending";
};

// Compute overall approvalStatus from steps before saving
irisRequirementSchema.pre("save", function (next) {
  const next_ = deriveApprovalStatus(this);
  if (next_ === "approved" && this.approvalStatus !== "approved") this.approvedAt = new Date();
  this.approvalStatus = next_;
  next();
});

const IrisReportingRequirement = mongoose.model(
  "IrisReportingRequirement",
  irisRequirementSchema
);

module.exports = {
  IrisReportingRequirement,
  deriveApprovalStatus,
  IRIS_STATUS,
  APPROVAL_STATUS,
  MATERIALITY,
  OBLIGATION_TYPE,
};
