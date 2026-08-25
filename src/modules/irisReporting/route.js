const express = require("express");
const multer  = require("multer");
const auth    = require("../../middlewares/auth");
const { isSuperAdmin } = require("../../middlewares/auth");
const ctrl    = require("./controller");

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 10 * 1024 * 1024 }, // 10 MB
});

// All IRIS routes require valid JWT + admin userType
const guard = [auth(), isSuperAdmin()];

router
  // Overview + report pack
  .get("/overview",     ...guard, ctrl.getOverview)
  .get("/report-pack",  ...guard, ctrl.getReportPack)

  // Legislation library — pre-loaded FMA/SD/AASB references
  .get("/legislation-library", ...guard, ctrl.getLegislationLibrary)

  // Obligation CRUD
  .post("/requirements",                      ...guard, ctrl.createRequirement)
  .patch("/requirements/:requirementId",      ...guard, ctrl.updateRequirement)
  .delete("/requirements/:requirementId",     ...guard, ctrl.deleteRequirement)

  // Bulk import obligations from the legislation library
  .post("/requirements/bulk-import",          ...guard, ctrl.bulkImportFromLibrary)

  // Dry-run validation
  .post("/requirements/validate",                          ...guard, ctrl.validateRequirement)
  .post("/requirements/:requirementId/validate",           ...guard, ctrl.validateRequirement)

  // Approval workflow
  .patch("/requirements/:requirementId/steps/:stepId/decision", ...guard, ctrl.decideApprovalStep)

  // Comments
  .post("/requirements/:requirementId/comments",              ...guard, ctrl.addComment)
  .delete("/requirements/:requirementId/comments/:commentId", ...guard, ctrl.deleteComment)

  // Evidence files
  .post("/requirements/:requirementId/files",             ...guard, upload.single("file"), ctrl.uploadEvidenceFile)
  .get("/requirements/:requirementId/files/:fileId",      ...guard, ctrl.downloadEvidenceFile)
  .delete("/requirements/:requirementId/files/:fileId",   ...guard, ctrl.deleteEvidenceFile);

module.exports = router;
