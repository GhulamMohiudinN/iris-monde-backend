const express = require("express");
const auth = require("../../middlewares/auth");
const { isSuperAdmin } = require("../../middlewares/auth");
const ctrl = require("./controller");

const router = express.Router();

const guard = [auth(), isSuperAdmin()];

router
  // Authenticated — sender's side
  .post("/",                  ...guard, ctrl.createContract)
  .get("/",                   auth(),   ctrl.listContracts)
  .get("/:contractId",        auth(),   ctrl.getContract)
  .delete("/:contractId",     ...guard, ctrl.deleteContract)

  // Public — the signer never logs in, the link token is the authorization
  .get("/public/:token",         ctrl.getPublicContract)
  .post("/public/:token/sign",   ctrl.signContract);

module.exports = router;
