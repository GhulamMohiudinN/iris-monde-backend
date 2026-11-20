const express = require("express");
const auth = require("../../middlewares/auth");
const { isSuperAdmin } = require("../../middlewares/auth");
const multer = require("multer");
const { buildFileFilter } = require("../../utils/uploadFilter");
const ctrl = require("./controller");

// The document the recipient reads before signing. PDF or Word only — the
// sign page has to be able to show or hand over whatever arrives here.
const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 10 * 1024 * 1024 }, // 10 MB
  fileFilter: buildFileFilter(["pdf", "doc", "docx"]),
});

const router = express.Router();

const guard = [auth(), isSuperAdmin()];

router
  // Authenticated — sender's side
  .post("/",                  ...guard, upload.single("document"), ctrl.createContract)
  .get("/",                   auth(),   ctrl.listContracts)
  .get("/:contractId",        auth(),   ctrl.getContract)
  .get("/:contractId/document", auth(), ctrl.getContractDocument)
  .delete("/:contractId",     ...guard, ctrl.deleteContract)

  // Public — the signer never logs in, the link token is the authorization
  .get("/public/:token",         ctrl.getPublicContract)
  .get("/public/:token/document", ctrl.getPublicDocument)
  .post("/public/:token/sign",   ctrl.signContract);

module.exports = router;
