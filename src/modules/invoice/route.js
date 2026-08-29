const express = require("express");
const auth    = require("../../middlewares/auth");
const { isSuperAdmin } = require("../../middlewares/auth");
const ctrl    = require("./controller");

const router = express.Router();

router.post("/send", auth(), isSuperAdmin(), ctrl.sendInvoice);

module.exports = router;
