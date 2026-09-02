const express = require("express");
const API_ROUTES = require("../config/apiRoutes");
const users = require("../modules/users/route");
const workspace = require("../modules/workspace/route");
const process = require("../modules/process/route");
const step = require("../modules/step/route");
const activityLog = require("../modules/activityLog/route");
const template = require("../modules/template/route");
const irisReporting = require("../modules/irisReporting/route");
const invoice = require("../modules/invoice/route");
const reportTemplate = require("../modules/reportTemplate/route");
const ai = require("../modules/ai/route");
const contract = require("../modules/contract/route");

module.exports = (app) => {
  const apiV1Router = express.Router();

  apiV1Router.use("/users", users);
  apiV1Router.use("/workspace", workspace);
  apiV1Router.use("/process", process);
  apiV1Router.use("/step", step);
  apiV1Router.use("/activity-log", activityLog);
  apiV1Router.use("/template", template);
  apiV1Router.use("/iris-reporting", irisReporting);
  apiV1Router.use("/invoices", invoice);
  apiV1Router.use("/report-templates", reportTemplate);
  apiV1Router.use("/ai", ai);
  apiV1Router.use("/contracts", contract);

  app.use("/api/v1", apiV1Router);
};
