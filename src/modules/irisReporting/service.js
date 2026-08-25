const mongoose  = require("mongoose");
const httpStatus = require("http-status");
const ApiError   = require("../../utils/ApiError");
const { IrisReportingRequirement } = require("./model");
const defaultRequirements          = require("./defaultData");
const { buildIrisReportingSummary }= require("./summary");
const { validateRequirement, applyMaterialityRules } = require("./businessRules");
const { logActivity } = require("../activityLog/service");
const { ACTIVITY_ACTIONS } = require("../activityLog/model");

// ─── Cloudinary setup ─────────────────────────────────────────────────────────
const cloudinary = require("cloudinary").v2;
if (process.env.CLOUDINARY_URL) {
  cloudinary.config({ url: process.env.CLOUDINARY_URL });
} else if (process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET) {
  cloudinary.config({
    cloud_name:  process.env.CLOUDINARY_CLOUD_NAME,
    api_key:     process.env.CLOUDINARY_API_KEY,
    api_secret:  process.env.CLOUDINARY_API_SECRET,
  });
}

const isCloudinaryReady = () => !!(
  process.env.CLOUDINARY_CLOUD_NAME &&
  process.env.CLOUDINARY_API_KEY &&
  process.env.CLOUDINARY_API_SECRET
);

// ─── Helpers ──────────────────────────────────────────────────────────────────
const normalizeDueDate = (value) => {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const serializeRequirement = (item) => ({
  ...item,
  dueDate:    item.dueDate    ? new Date(item.dueDate).toISOString()    : null,
  approvedAt: item.approvedAt ? new Date(item.approvedAt).toISOString() : null,
});

// ─── Overview ─────────────────────────────────────────────────────────────────
const getOverview = async ({ workspaceId }) => {
  const existing = await IrisReportingRequirement.find({ workspaceId }).lean();

  if (existing.length) {
    const requirements = existing.map(serializeRequirement);
    return { requirements, summary: buildIrisReportingSummary(requirements) };
  }

  // Seed default data on first load
  const seeded = await IrisReportingRequirement.insertMany(
    defaultRequirements.map((item) => ({
      workspaceId,
      ...item,
      dueDate: normalizeDueDate(item.dueDate),
      // Give each approval step a proper ObjectId
      approvalSteps: (item.approvalSteps || []).map((step) => ({
        ...step,
        _id: new mongoose.Types.ObjectId(),
      })),
    }))
  );

  const requirements = seeded.map((item) => serializeRequirement(item.toObject()));
  return { requirements, summary: buildIrisReportingSummary(requirements) };
};

// ─── Report Pack ──────────────────────────────────────────────────────────────
const getReportPack = async ({ workspaceId }) => {
  const overview = await getOverview({ workspaceId });
  return {
    generatedAt:     new Date().toISOString(),
    summary:         overview.summary,
    requirements:    overview.requirements,
    recommendation:  "Maintain a single evidence register per obligation and link each item to the appropriate report template before sign-off.",
  };
};

// ─── Create Requirement ───────────────────────────────────────────────────────
const createRequirement = async ({ workspaceId, payload, actor }) => {
  // Apply materiality auto-rules before validation
  applyMaterialityRules(payload);

  // Validate — block on errors, allow warnings through
  const validation = validateRequirement({ ...payload, evidenceFiles: [] });
  if (!validation.valid) {
    throw new ApiError(httpStatus.UNPROCESSABLE_ENTITY, validation.errors[0]);
  }

  const requirement = await IrisReportingRequirement.create({
    workspaceId,
    title:              payload.title,
    source:             payload.source             || "Client requirement",
    legislationRef:     payload.legislationRef     || "",
    category:           payload.category           || "Reporting",
    obligationType:     payload.obligationType     || "reporting",
    status:             payload.status             || "planned",
    dueDate:            normalizeDueDate(payload.dueDate),
    owner:              payload.owner              || "Operations",
    reportType:         payload.reportType         || "Statutory report",
    materiality:        payload.materiality        || "Standard",
    approvalRequired:   Boolean(payload.approvalRequired),
    evidenceRequired:   Array.isArray(payload.evidenceRequired) ? payload.evidenceRequired.filter(Boolean) : [],
    details:            payload.details            || "",
    legislationVersion: payload.legislationVersion || "",
    ruleVersion:        payload.ruleVersion        || "1.0",
    reportingPeriod:    payload.reportingPeriod    || "",
    approvalSteps: (Array.isArray(payload.approvalSteps) ? payload.approvalSteps : []).map((step) => ({
      ...step,
      _id:    new mongoose.Types.ObjectId(),
      status: "pending",
    })),
  });

  await logActivity({
    workspaceId,
    actor,
    action: ACTIVITY_ACTIONS.CREATE_IRIS_REQUIREMENT,
    entityType: "iris_requirement",
    entityId: requirement._id,
    message: `${actor?.name || actor?.email || "Someone"} created IRIS obligation "${requirement.title}"`,
    data: { title: requirement.title, status: requirement.status, materiality: requirement.materiality },
  });

  return serializeRequirement(requirement.toObject());
};

// ─── Update Requirement ───────────────────────────────────────────────────────
const updateRequirement = async ({ workspaceId, requirementId, payload, actor }) => {
  const req = await IrisReportingRequirement.findOne({ _id: requirementId, workspaceId });
  if (!req) throw new ApiError(httpStatus.NOT_FOUND, "Reporting requirement not found");

  // Build the merged state to validate against
  const merged = {
    ...req.toObject(),
    ...payload,
    evidenceFiles: req.evidenceFiles || [],
  };

  applyMaterialityRules(merged);

  const validation = validateRequirement(merged);
  if (!validation.valid) {
    throw new ApiError(httpStatus.UNPROCESSABLE_ENTITY, validation.errors[0]);
  }

  const fields = [
    "title", "source", "legislationRef", "category", "obligationType",
    "status", "owner", "reportType", "materiality", "details",
    "legislationVersion", "ruleVersion", "reportingPeriod",
  ];
  fields.forEach((f) => { if (payload[f] !== undefined) req[f] = payload[f]; });

  if (payload.dueDate          !== undefined) req.dueDate          = normalizeDueDate(payload.dueDate);
  if (payload.approvalRequired !== undefined) req.approvalRequired = Boolean(payload.approvalRequired);
  if (payload.evidenceRequired !== undefined) req.evidenceRequired = Array.isArray(payload.evidenceRequired) ? payload.evidenceRequired.filter(Boolean) : [];

  // Replace approval steps if provided
  if (Array.isArray(payload.approvalSteps)) {
    req.approvalSteps = payload.approvalSteps.map((step) => ({
      ...step,
      _id: step._id ? new mongoose.Types.ObjectId(step._id) : new mongoose.Types.ObjectId(),
    }));
  }

  await req.save();

  await logActivity({
    workspaceId,
    actor,
    action: ACTIVITY_ACTIONS.UPDATE_IRIS_REQUIREMENT,
    entityType: "iris_requirement",
    entityId: req._id,
    message: `${actor?.name || actor?.email || "Someone"} updated IRIS obligation "${req.title}"`,
    data: { title: req.title, status: req.status },
  });

  return serializeRequirement(req.toObject());
};

// ─── Delete Requirement ───────────────────────────────────────────────────────
const deleteRequirement = async ({ workspaceId, requirementId, actor }) => {
  const req = await IrisReportingRequirement.findOneAndDelete({ _id: requirementId, workspaceId });
  if (!req) throw new ApiError(httpStatus.NOT_FOUND, "Reporting requirement not found");

  await logActivity({
    workspaceId,
    actor,
    action: ACTIVITY_ACTIONS.DELETE_IRIS_REQUIREMENT,
    entityType: "iris_requirement",
    entityId: req._id,
    message: `${actor?.name || actor?.email || "Someone"} deleted IRIS obligation "${req.title}"`,
    data: { title: req.title },
  });

  return { id: requirementId };
};

// ─── Approval Step decision ───────────────────────────────────────────────────
const decideApprovalStep = async ({ workspaceId, requirementId, stepId, decision, notes, decidedBy, actor }) => {
  if (!["approved", "rejected"].includes(decision)) {
    throw new ApiError(httpStatus.BAD_REQUEST, "decision must be 'approved' or 'rejected'");
  }

  const req = await IrisReportingRequirement.findOne({ _id: requirementId, workspaceId });
  if (!req) throw new ApiError(httpStatus.NOT_FOUND, "Reporting requirement not found");

  const step = req.approvalSteps.id(stepId);
  if (!step) throw new ApiError(httpStatus.NOT_FOUND, "Approval step not found");

  step.status     = decision;
  step.decidedAt  = new Date();
  step.decidedBy  = decidedBy || "System";
  step.notes      = notes     || "";

  await req.save(); // pre-save hook recalculates req.approvalStatus

  await logActivity({
    workspaceId,
    actor,
    action: ACTIVITY_ACTIONS.DECIDE_IRIS_APPROVAL_STEP,
    entityType: "iris_requirement",
    entityId: req._id,
    message: `${actor?.name || actor?.email || decidedBy || "Someone"} ${decision} approval step "${step.stepName}" on "${req.title}"`,
    data: { stepName: step.stepName, decision, notes: notes || "" },
  });

  return serializeRequirement(req.toObject());
};

// ─── Add Comment ─────────────────────────────────────────────────────────────
const addComment = async ({ workspaceId, requirementId, text, authorId, authorName, actor }) => {
  const req = await IrisReportingRequirement.findOne({ _id: requirementId, workspaceId });
  if (!req) throw new ApiError(httpStatus.NOT_FOUND, "Reporting requirement not found");

  const commentId = new mongoose.Types.ObjectId();
  req.comments.push({
    _id:        commentId,
    text:       text.trim(),
    authorId:   authorId   || "system",
    authorName: authorName || "System",
    createdAt:  new Date(),
  });

  await req.save();
  const added = req.comments.id(commentId);

  await logActivity({
    workspaceId,
    actor,
    action: ACTIVITY_ACTIONS.ADD_IRIS_COMMENT,
    entityType: "iris_requirement",
    entityId: req._id,
    message: `${actor?.name || actor?.email || authorName || "Someone"} commented on "${req.title}"`,
    data: { commentId: added._id, text: added.text },
  });

  return { _id: added._id, text: added.text, authorName: added.authorName, createdAt: added.createdAt };
};

// ─── Delete Comment ───────────────────────────────────────────────────────────
const deleteComment = async ({ workspaceId, requirementId, commentId, actor }) => {
  const req = await IrisReportingRequirement.findOne({ _id: requirementId, workspaceId });
  if (!req) throw new ApiError(httpStatus.NOT_FOUND, "Reporting requirement not found");

  const comment = req.comments.id(commentId);
  if (!comment) throw new ApiError(httpStatus.NOT_FOUND, "Comment not found");

  comment.deleteOne();
  await req.save();

  await logActivity({
    workspaceId,
    actor,
    action: ACTIVITY_ACTIONS.DELETE_IRIS_COMMENT,
    entityType: "iris_requirement",
    entityId: req._id,
    message: `${actor?.name || actor?.email || "Someone"} deleted a comment on "${req.title}"`,
    data: { commentId },
  });

  return { commentId };
};

// ─── Upload Evidence File ─────────────────────────────────────────────────────
const uploadEvidenceFile = async ({ workspaceId, requirementId, fileBuffer, fileName, fileType, actor }) => {
  const req = await IrisReportingRequirement.findOne({ _id: requirementId, workspaceId });
  if (!req) throw new ApiError(httpStatus.NOT_FOUND, "Reporting requirement not found");

  const fileSize = fileBuffer.length;
  let fileUrl, publicId = null;

  if (isCloudinaryReady()) {
    const dataUri    = `data:${fileType};base64,${fileBuffer.toString("base64")}`;
    const result     = await cloudinary.uploader.upload(dataUri, {
      folder:        process.env.CLOUDINARY_FOLDER || "iris_reporting",
      resource_type: "auto",
    });
    fileUrl  = result.secure_url || result.url;
    publicId = result.public_id;
  } else {
    console.warn("[IRIS] Cloudinary not configured — storing file as base64 (dev fallback)");
    fileUrl = `data:${fileType};base64,${fileBuffer.toString("base64")}`;
  }

  const fileId = new mongoose.Types.ObjectId();
  req.evidenceFiles.push({
    _id:        fileId,
    fileName,
    fileType,
    fileSize,
    url:        fileUrl,
    publicId:   publicId || "",
    uploadedBy: actor?.name || actor?.email || "System",
    uploadedAt: new Date(),
  });

  await req.save();

  await logActivity({
    workspaceId,
    actor,
    action: ACTIVITY_ACTIONS.UPLOAD_IRIS_EVIDENCE,
    entityType: "iris_requirement",
    entityId: req._id,
    message: `${actor?.name || actor?.email || "Someone"} uploaded evidence "${fileName}" to "${req.title}"`,
    data: { fileName, fileSize },
  });

  return {
    fileId:     fileId.toString(),
    fileName, fileType, fileSize,
    url:        fileUrl,
    publicId:   publicId || "",
    uploadedAt: new Date().toISOString(),
  };
};

// ─── Get Evidence File ────────────────────────────────────────────────────────
const getEvidenceFile = async ({ workspaceId, requirementId, fileId }) => {
  const req = await IrisReportingRequirement.findOne(
    { _id: requirementId, workspaceId, "evidenceFiles._id": fileId },
    { "evidenceFiles.$": 1 }
  );
  if (!req?.evidenceFiles?.length) {
    throw new ApiError(httpStatus.NOT_FOUND, "Evidence file not found");
  }
  const file = req.evidenceFiles[0];
  return { fileName: file.fileName, fileType: file.fileType, url: file.url, publicId: file.publicId };
};

// ─── Delete Evidence File ─────────────────────────────────────────────────────
const deleteEvidenceFile = async ({ workspaceId, requirementId, fileId, actor }) => {
  const req = await IrisReportingRequirement.findOne({ _id: requirementId, workspaceId });
  if (!req) throw new ApiError(httpStatus.NOT_FOUND, "Reporting requirement not found");

  const file = req.evidenceFiles.find((f) => f._id.toString() === fileId);
  if (file?.publicId && isCloudinaryReady()) {
    try {
      await cloudinary.uploader.destroy(file.publicId, { resource_type: "auto" });
    } catch (err) {
      console.warn("[IRIS] Cloudinary delete error:", err.message);
    }
  }

  req.evidenceFiles = req.evidenceFiles.filter((f) => f._id.toString() !== fileId);
  await req.save();

  await logActivity({
    workspaceId,
    actor,
    action: ACTIVITY_ACTIONS.DELETE_IRIS_EVIDENCE,
    entityType: "iris_requirement",
    entityId: req._id,
    message: `${actor?.name || actor?.email || "Someone"} deleted evidence "${file?.fileName || fileId}" from "${req.title}"`,
    data: { fileName: file?.fileName || null, fileId },
  });

  return { fileId };
};

// ─── Validate (dry-run — no save) ────────────────────────────────────────────
const validateOnly = async ({ workspaceId, requirementId, payload }) => {
  let base = {};
  if (requirementId) {
    const existing = await IrisReportingRequirement.findOne({ _id: requirementId, workspaceId });
    if (existing) base = existing.toObject();
  }
  const merged = { ...base, ...payload, evidenceFiles: base.evidenceFiles || [] };
  return validateRequirement(merged);
};

// ─── Legislation Library ──────────────────────────────────────────────────────
// Reads from MongoDB (populated by seedLegislationLibrary.js).
// Falls back to the static file if the collection is empty — safe for dev
// environments that haven't run the seed script yet.
const { LegislationLibrary } = require("./legislationLibraryModel");

const getLegislationLibrary = async () => {
  try {
    const docs = await LegislationLibrary.find({ archived: false })
      .sort({ source: 1, ref: 1 })
      .lean();

    if (docs.length > 0) {
      return docs.map(({ ref, title, source, category, obligationType, defaultMateriality }) => ({
        ref, title, source, category, obligationType, defaultMateriality,
      }));
    }

    // DB collection is empty — fall back to static file (dev convenience)
    console.warn("[IRIS] LegislationLibrary collection is empty — using static fallback. Run: node scripts/seedLegislationLibrary.js");
    return require("./legislationLibrary");

  } catch (err) {
    console.error("[IRIS] getLegislationLibrary DB error, using static fallback:", err.message);
    return require("./legislationLibrary");
  }
};

// ─── Bulk Import from Legislation Library ────────────────────────────────────
// Turns every (or a selected set of) legislation library entries into real
// obligations for this workspace in one shot, instead of the user re-typing
// each one by hand. Safe to re-run — entries already present (matched by
// legislationRef) are skipped, never duplicated.
const bulkImportFromLibrary = async ({ workspaceId, refs, actor }) => {
  const library = await getLegislationLibrary();

  const source = Array.isArray(refs) && refs.length
    ? library.filter((item) => refs.includes(item.ref))
    : library;

  if (!source.length) {
    return { imported: 0, skipped: 0, total: 0 };
  }

  const existing = await IrisReportingRequirement.find(
    { workspaceId, legislationRef: { $in: source.map((s) => s.ref) } },
    { legislationRef: 1 }
  ).lean();
  const existingRefs = new Set(existing.map((e) => e.legislationRef));

  const toInsert = source
    .filter((item) => item.ref && !existingRefs.has(item.ref))
    .map((item) => {
      const draft = {
        materiality: item.defaultMateriality || "Standard",
        approvalRequired: undefined,
      };
      applyMaterialityRules(draft);

      return {
        workspaceId,
        title:              item.title || item.ref,
        source:             item.source || "Legislation library",
        legislationRef:     item.ref,
        category:           item.category || "Reporting",
        obligationType:     item.obligationType || "reporting",
        status:             "planned",
        owner:              "",
        reportType:         "Statutory report",
        materiality:        draft.materiality,
        approvalRequired:   Boolean(draft.approvalRequired),
        evidenceRequired:   [],
        details:            `Imported from the legislation library (${item.source || "reference library"}).`,
        legislationVersion: "",
        ruleVersion:        "1.0",
        reportingPeriod:    "",
      };
    });

  const inserted = toInsert.length ? await IrisReportingRequirement.insertMany(toInsert) : [];

  if (inserted.length) {
    await logActivity({
      workspaceId,
      actor,
      action: ACTIVITY_ACTIONS.CREATE_IRIS_REQUIREMENT,
      entityType: "iris_requirement",
      entityId: null,
      message: `${actor?.name || actor?.email || "Someone"} imported ${inserted.length} obligation${inserted.length === 1 ? "" : "s"} from the legislation library`,
      data: { count: inserted.length, refs: inserted.map((r) => r.legislationRef) },
    });
  }

  return {
    imported: inserted.length,
    skipped:  source.length - toInsert.length,
    total:    source.length,
  };
};

module.exports = {
  getOverview,
  getReportPack,
  createRequirement,
  updateRequirement,
  deleteRequirement,
  decideApprovalStep,
  addComment,
  deleteComment,
  uploadEvidenceFile,
  getEvidenceFile,
  deleteEvidenceFile,
  validateOnly,
  getLegislationLibrary,
  bulkImportFromLibrary,
};
