const httpStatus = require("http-status");
const catchAsync = require("../../utils/catchAsync");
const svc        = require("./service");

const workspaceId = (req) => req.user?.workspaceId || req.user?.workspace?._id;

// ── Overview / Report Pack ────────────────────────────────────────────────────
const getOverview = catchAsync(async (req, res) => {
  const result = await svc.getOverview({ workspaceId: workspaceId(req) });
  res.status(httpStatus.OK).json({ success: true, ...result });
});

const getReportPack = catchAsync(async (req, res) => {
  const result = await svc.getReportPack({ workspaceId: workspaceId(req) });
  res.status(httpStatus.OK).json({ success: true, ...result });
});

// ── CRUD ──────────────────────────────────────────────────────────────────────
const createRequirement = catchAsync(async (req, res) => {
  const requirement = await svc.createRequirement({ workspaceId: workspaceId(req), payload: req.body, actor: req.user });
  res.status(httpStatus.CREATED).json({ success: true, requirement });
});

const updateRequirement = catchAsync(async (req, res) => {
  const requirement = await svc.updateRequirement({
    workspaceId:   workspaceId(req),
    requirementId: req.params.requirementId,
    payload:       req.body,
    actor:         req.user,
  });
  res.status(httpStatus.OK).json({ success: true, requirement });
});

const deleteRequirement = catchAsync(async (req, res) => {
  const result = await svc.deleteRequirement({ workspaceId: workspaceId(req), requirementId: req.params.requirementId, actor: req.user });
  res.status(httpStatus.OK).json({ success: true, ...result });
});

// ── Approval Workflow ─────────────────────────────────────────────────────────
const decideApprovalStep = catchAsync(async (req, res) => {
  const { requirementId, stepId } = req.params;
  const { decision, notes }       = req.body;
  const decidedBy = req.user?.name || req.user?.email || "Unknown";

  const requirement = await svc.decideApprovalStep({
    workspaceId: workspaceId(req),
    requirementId, stepId, decision, notes, decidedBy,
    actor: req.user,
  });
  res.status(httpStatus.OK).json({ success: true, requirement });
});

// ── Comments ──────────────────────────────────────────────────────────────────
const addComment = catchAsync(async (req, res) => {
  const { requirementId } = req.params;
  const { text }          = req.body;
  if (!text?.trim()) {
    return res.status(httpStatus.BAD_REQUEST).json({ success: false, message: "Comment text is required" });
  }
  const comment = await svc.addComment({
    workspaceId:  workspaceId(req),
    requirementId,
    text,
    authorId:   req.user?._id?.toString(),
    authorName: req.user?.name || req.user?.email || "Unknown",
    actor:      req.user,
  });
  res.status(httpStatus.CREATED).json({ success: true, comment });
});

const deleteComment = catchAsync(async (req, res) => {
  const { requirementId, commentId } = req.params;
  const result = await svc.deleteComment({ workspaceId: workspaceId(req), requirementId, commentId, actor: req.user });
  res.status(httpStatus.OK).json({ success: true, ...result });
});

// ── Evidence Files ────────────────────────────────────────────────────────────
const uploadEvidenceFile = catchAsync(async (req, res) => {
  if (!req.file) {
    return res.status(httpStatus.BAD_REQUEST).json({ success: false, message: "No file uploaded" });
  }
  const { originalname, buffer, mimetype } = req.file;
  const result = await svc.uploadEvidenceFile({
    workspaceId:   workspaceId(req),
    requirementId: req.params.requirementId,
    fileBuffer:    buffer,
    fileName:      originalname,
    fileType:      mimetype,
    actor:         req.user,
  });
  res.status(httpStatus.OK).json({ success: true, file: result });
});

const downloadEvidenceFile = catchAsync(async (req, res) => {
  const result = await svc.getEvidenceFile({
    workspaceId:   workspaceId(req),
    requirementId: req.params.requirementId,
    fileId:        req.params.fileId,
  });
  res.status(httpStatus.OK).json({ success: true, file: result });
});

const deleteEvidenceFile = catchAsync(async (req, res) => {
  const result = await svc.deleteEvidenceFile({
    workspaceId:   workspaceId(req),
    requirementId: req.params.requirementId,
    fileId:        req.params.fileId,
    actor:         req.user,
  });
  res.status(httpStatus.OK).json({ success: true, ...result });
});

// ── Legislation Library ───────────────────────────────────────────────────────
const getLegislationLibrary = catchAsync(async (req, res) => {
  const library = await svc.getLegislationLibrary();
  res.status(httpStatus.OK).json({ success: true, library });
});

// ── Validate (dry-run) ────────────────────────────────────────────────────────
const validateRequirement = catchAsync(async (req, res) => {
  const { requirementId } = req.params; // optional
  const result = await svc.validateOnly({
    workspaceId:   workspaceId(req),
    requirementId: requirementId || null,
    payload:       req.body,
  });
  res.status(httpStatus.OK).json({ success: true, ...result });
});

module.exports = {
  getOverview, getReportPack,
  createRequirement, updateRequirement, deleteRequirement,
  decideApprovalStep,
  addComment, deleteComment,
  uploadEvidenceFile, downloadEvidenceFile, deleteEvidenceFile,
  getLegislationLibrary,
  validateRequirement,
};
