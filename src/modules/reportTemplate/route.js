const express = require("express");
const multer  = require("multer");
const auth    = require("../../middlewares/auth");
const { isSuperAdmin } = require("../../middlewares/auth");
const { buildFileFilter } = require("../../utils/uploadFilter");
const ctrl    = require("./controller");

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 10 * 1024 * 1024 }, // 10 MB
  // Matches both the UI's accept list and the .docx/.xlsx check in the service.
  fileFilter: buildFileFilter(["docx", "xlsx"]),
});

const guard = [auth(), isSuperAdmin()];

router
  .post("/",                       ...guard, upload.single("file"), ctrl.uploadTemplate)
  .get("/",                        ...guard, ctrl.listTemplates)
  .delete("/:templateId",          ...guard, ctrl.deleteTemplate)
  .post("/:templateId/generate",   ...guard, ctrl.generateFromTemplate)
  .post("/finalize-xlsx",          ...guard, ctrl.finalizeXlsx);

module.exports = router;
