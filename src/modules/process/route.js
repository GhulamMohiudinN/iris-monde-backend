const express = require('express');
const auth = require('../../middlewares/auth');
const { isSuperAdmin, requireRole } = require('../../middlewares/auth');
const processController = require('./controller');
const API_ROUTES = require('../../config/apiRoutes');

const router = express.Router();

router
    .post(API_ROUTES.PROCESS.CREATE_PROCESS, auth(), requireRole('admin', 'editor'), processController.createProcess)
    .patch(API_ROUTES.PROCESS.UPDATE_PROCESS, auth(), requireRole('admin', 'editor'), processController.updateProcess)
    .delete(API_ROUTES.PROCESS.DELETE_PROCESS, auth(), isSuperAdmin(), processController.deleteProcess)
    .get(API_ROUTES.PROCESS.LIST_WORKSPACE_PROCESS, auth(), requireRole('admin', 'editor', 'viewer'), processController.getWorkspaceProcesses)
    .get(API_ROUTES.PROCESS.LIST_ASSIGNED_PROCESS, auth(), processController.getAssignedProcesses)
    .get(API_ROUTES.PROCESS.GET_SINGLE_PROCESS, auth(), processController.getProcessById);

module.exports = router;
