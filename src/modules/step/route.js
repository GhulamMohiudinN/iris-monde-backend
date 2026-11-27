const express = require("express");
const auth = require("../../middlewares/auth");
const { requireRole } = require("../../middlewares/auth");
const stepController = require("./controller");
const API_ROUTES = require("../../config/apiRoutes");

const router = express.Router();

router
  .patch(
    API_ROUTES.STEP.UPDATE_STEP,
    auth(),
    requireRole("admin", "editor"),
    stepController.updateStep,
  )
  .patch(API_ROUTES.STEP.COMPLETE_STEP, auth(), stepController.completeStep)
  .delete(
    API_ROUTES.STEP.DELETE_STEP,
    auth(),
    requireRole("admin", "editor"),
    stepController.deleteStep,
  );

module.exports = router;
