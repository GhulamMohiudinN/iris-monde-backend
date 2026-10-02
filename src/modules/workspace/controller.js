const httpStatus = require('http-status');
const ApiError = require('../../utils/ApiError');
const catchAsync = require('../../utils/catchAsync');
const workspaceService = require('./service');
const workspaceValidation = require('./valadition');
const { userService, tokenService, emailService } = require('../../services');
const jwt = require('jsonwebtoken');
const config = require('../../config/config');
const { logActivity } = require('../activityLog/service');
const { ACTIVITY_ACTIONS } = require('../activityLog/model');

const getValidationError = (validationResult) => {
    if (!validationResult?.error) return null;
    return {
        isSuccess: false,
        message: validationResult.msg,
    };
};

const createWorkspace = catchAsync(async (req, res) => {
    const validationResult = workspaceValidation.validateCreateWorkspaceInputs(req.body);
    const validationError = getValidationError(validationResult);
    if (validationError) {
        return res.status(httpStatus.BAD_REQUEST).send(validationError);
    }

    const createPayload = {
        ...validationResult.value,
        adminId: req.user._id,
        adminEmail: req.user.email,
        companyEmail: validationResult.value.companyEmail,
    };

    const workspace = await workspaceService.createNewWorkspace(createPayload);
    if (!workspace) {
        throw new ApiError(httpStatus.NOT_FOUND, 'Error in creating workspace');
    }

    const populatedWorkspace = await workspaceService.getPopulatedWorkspace(workspace._id);
    const updatedUser = await userService.getUserById(req.user._id);

    res.send({
        success: true,
        workspace: populatedWorkspace,
        user: {
            id: updatedUser._id,
            name: updatedUser.name,
            email: updatedUser.email,
            username: updatedUser.username,
            isEmailVerified: updatedUser.isEmailVerified,
            userType: updatedUser.userType,
            workspaceId: updatedUser.workspaceId,
            invitationStatus: updatedUser.invitationStatus,
        },
    });
});

const updateWorkspace = catchAsync(async (req, res) => {
    const validationResult = workspaceValidation.validateUpdateWorkspaceInputs(req.body);
    const validationError = getValidationError(validationResult);
    if (validationError) {
        return res.status(httpStatus.BAD_REQUEST).send(validationError);
    }

    const workspaceId = req.user?.workspaceId || req.workspace?._id;
    if (!workspaceId) {
        return res.status(httpStatus.NOT_FOUND).send({
            isSuccess: false,
            message: 'Workspace not found for this user.',
        });
    }

    const { changes, message: changeMessage } = await workspaceService.getWorkspaceChanges(workspaceId, validationResult.value);

    const updatedWorkspace = await workspaceService.updateWorkspaceById(workspaceId, validationResult.value);
    if (!updatedWorkspace) {
        throw new ApiError(httpStatus.NOT_FOUND, 'Workspace not found');
    }

    await logActivity({
        workspaceId,
        actor: req.user,
        action: ACTIVITY_ACTIONS.UPDATE_ORGANIZATION,
        entityType: 'workspace',
        entityId: workspaceId,
        message: `${req.user.name || req.user.email} updated organization settings — ${changeMessage}`,
        data: changes,
    });

    return res.send({
        success: true,
        workspace: updatedWorkspace,
    });
});

const getUserWorkspace = catchAsync(async (req, res) => {
    if (!req.user?.workspaceId || !req.workspace) {
        return res.status(httpStatus.NOT_FOUND).send({
            isSuccess: false,
            message: 'Workspace not found for this user.',
        });
    }

    return res.send({
        success: true,
        workspace: req.workspace,
    });
});

const addMember = catchAsync(async (req, res) => {
    return res.status(httpStatus.BAD_REQUEST).send({
        isSuccess: false,
        message: 'Members are disabled for company workspace.',
    });
});

const addMemberWithEmail = catchAsync(async (req, res) => {
    return res.status(httpStatus.BAD_REQUEST).send({
        isSuccess: false,
        message: 'Members are disabled for company workspace.',
    });
});

const verifyInviteToken = catchAsync(async (req, res) => {
    return res.status(httpStatus.BAD_REQUEST).send({
        isSuccess: false,
        message: 'Members are disabled for company workspace.',
    });
});

const updateMemberRole = catchAsync(async (req, res) => {
    return res.status(httpStatus.BAD_REQUEST).send({
        isSuccess: false,
        message: 'Members are disabled for company workspace.',
    });
});

const deleteMember = catchAsync(async (req, res) => {
    return res.status(httpStatus.BAD_REQUEST).send({
        isSuccess: false,
        message: 'Members are disabled for company workspace.',
    });
});

const workspaceOverview = catchAsync(async (req, res) => {
    if (!req.user?.workspaceId) {
        return res.status(httpStatus.BAD_REQUEST).send({
            isSuccess: false,
            message: 'No active workspace found for user.',
        });
    }

    const data = await workspaceService.getWorkspaceOverview({ workspaceId: req.user.workspaceId });

    return res.status(httpStatus.OK).send({
        success: true,
        ...data,
    });
});

/**
 * Deletes the caller's own workspace and everything in it.
 *
 * The workspace name is required in the body and must match. The settings
 * screen already asks the user to type it, but that check lives in the
 * browser: without repeating it here, anything holding a valid admin token
 * could destroy a workspace with a bare request and no confirmation at all.
 */
const deleteWorkspace = catchAsync(async (req, res) => {
    const workspaceId = req.user?.workspaceId;
    if (!workspaceId) {
        throw new ApiError(httpStatus.BAD_REQUEST, 'You do not belong to a workspace');
    }

    const workspace = await workspaceService.getWorkspaceById(workspaceId);
    if (!workspace) {
        throw new ApiError(httpStatus.NOT_FOUND, 'Workspace not found');
    }

    const expected = workspace.companyName || workspace.userName || '';
    const provided = String(req.body?.confirmName || '').trim();
    if (!provided || provided !== expected) {
        throw new ApiError(
            httpStatus.BAD_REQUEST,
            `To confirm, send the workspace name exactly as it appears: "${expected}"`
        );
    }

    const result = await workspaceService.deleteWorkspaceAndData(workspaceId);

    return res.send({
        success: true,
        message: `${result.companyName} and all of its data have been permanently deleted.`,
        ...result,
    });
});

module.exports = {
    createWorkspace,
    deleteWorkspace,
    updateWorkspace,
    getUserWorkspace,
    addMember,
    addMemberWithEmail,
    verifyInviteToken,
    updateMemberRole,
    deleteMember,
    workspaceOverview,
};
