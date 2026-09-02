const mongoose = require('mongoose');

const ACTIVITY_ACTIONS = {
    // Member / Invitation
    INVITE_MEMBER: 'invite_member',
    ACCEPT_INVITATION: 'accept_invitation',
    UPDATE_MEMBER: 'update_member',
    REMOVE_MEMBER: 'remove_member',

    // Workspace / Organisation
    CREATE_WORKSPACE: 'create_workspace',
    UPDATE_ORGANIZATION: 'update_organization',

    // Process
    CREATE_PROCESS: 'create_process',
    UPDATE_PROCESS: 'update_process',
    DELETE_PROCESS: 'delete_process',

    // Step
    CREATE_STEP: 'create_step',
    UPDATE_STEP: 'update_step',
    DELETE_STEP: 'delete_step',

    // IRIS Reporting
    CREATE_IRIS_REQUIREMENT: 'create_iris_requirement',
    UPDATE_IRIS_REQUIREMENT: 'update_iris_requirement',
    DELETE_IRIS_REQUIREMENT: 'delete_iris_requirement',
    UPLOAD_IRIS_EVIDENCE: 'upload_iris_evidence',
    DELETE_IRIS_EVIDENCE: 'delete_iris_evidence',
    DECIDE_IRIS_APPROVAL_STEP: 'decide_iris_approval_step',
    ADD_IRIS_COMMENT: 'add_iris_comment',
    DELETE_IRIS_COMMENT: 'delete_iris_comment',

    // Contracts
    CREATE_CONTRACT: 'create_contract',
    SIGN_CONTRACT: 'sign_contract',
    CANCEL_CONTRACT: 'cancel_contract',
};

const ACTIVITY_ENTITY_TYPES = ['workspace', 'process', 'step', 'user', 'iris_requirement', 'contract'];

const activityLogSchema = new mongoose.Schema(
    {
        workspaceId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Workspace',
            required: true,
            index: true,
        },
        userId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            required: true,
            index: true,
        },
        userName: { type: String, default: '' },
        userEmail: { type: String, default: '' },
        action: {
            type: String,
            required: true,
            enum: Object.values(ACTIVITY_ACTIONS),
            index: true,
        },
        entityType: {
            type: String,
            enum: ACTIVITY_ENTITY_TYPES,
            required: true,
        },
        entityId: {
            type: mongoose.Schema.Types.ObjectId,
            default: null,
        },
        message: {
            type: String,
            required: true,
        },
        data: {
            type: mongoose.Schema.Types.Mixed,
            default: null,
        },
    },
    {
        timestamps: true,
    }
);

const ActivityLog = mongoose.model('ActivityLog', activityLogSchema);

module.exports = {
    ActivityLog,
    ACTIVITY_ACTIONS,
    ACTIVITY_ENTITY_TYPES,
};
