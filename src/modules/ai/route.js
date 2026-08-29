const express = require("express");
const auth    = require("../../middlewares/auth");
const ctrl    = require("./controller");

const router = express.Router();

// Any logged-in user can chat — sensitive actions (like inviting a member)
// are still enforced by the real API endpoints the widget calls, which
// already require admin rights on their own.
router.post("/chat", auth(), ctrl.chat);

module.exports = router;
