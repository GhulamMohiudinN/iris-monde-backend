const express = require("express");
const auth = require("../../middlewares/auth");
const ctrl = require("./controller");

const router = express.Router();

// Every route acts only on the signed-in user's own notifications, so any
// signed-in user may call them — the scoping is in the service.
router
  .get("/",                          auth(), ctrl.list)
  .get("/unread-count",              auth(), ctrl.unreadCount)
  .patch("/read-all",                auth(), ctrl.markAllRead)
  .patch("/:notificationId/read",    auth(), ctrl.markRead);

module.exports = router;
