const Workspace = require('./model');
const { User } = require('../../models');
const { Process } = require('../process/model');
const { ActivityLog } = require('../activityLog/model');
const { Template } = require('../template/model');
const DEFAULT_TEMPLATES = require('../template/defaultTemplates');
const { IrisReportingRequirement } = require('../irisReporting/model');
const { ReportTemplate } = require('../reportTemplate/model');

// Shared plan cap shown in the UI (e.g. sidebar "x GB of 10 GB used").
// No per-workspace plan/billing tiers exist yet, so every workspace is
// measured against this same limit until that's built.
const STORAGE_LIMIT_BYTES = 10 * 1024 * 1024 * 1024; // 10 GB

const getWorkspaceStorageUsage = async (workspaceId) => {
    const [evidenceAgg, templateAgg] = await Promise.all([
        IrisReportingRequirement.aggregate([
            { $match: { workspaceId } },
            { $unwind: { path: '$evidenceFiles', preserveNullAndEmptyArrays: false } },
            { $group: { _id: null, bytes: { $sum: '$evidenceFiles.fileSize' } } },
        ]),
        ReportTemplate.aggregate([
            { $match: { workspaceId } },
            { $group: { _id: null, bytes: { $sum: '$fileSize' } } },
        ]),
    ]);

    const usedBytes = (evidenceAgg[0]?.bytes || 0) + (templateAgg[0]?.bytes || 0);
    const percent = Math.min(100, Math.round((usedBytes / STORAGE_LIMIT_BYTES) * 100));

    return { usedBytes, limitBytes: STORAGE_LIMIT_BYTES, percent };
};

const generateWorkspaceCode = async (companyName = 'company') => {
    const base = (companyName || 'company')
        .replace(/[^a-zA-Z0-9]/g, '')
        .toUpperCase()
        .slice(0, 5) || 'CMPNY';

    let candidate = `${base}${Math.floor(1000 + Math.random() * 9000)}`;
    let attempts = 0;

    while (await Workspace.findOne({ userName: candidate })) {
        attempts += 1;
        candidate = `${base}${Math.floor(1000 + Math.random() * 9000)}`;
        if (attempts > 30) {
            candidate = `${base}${Date.now().toString().slice(-6)}`;
            break;
        }
    }

    return candidate;
};

const createNewWorkspace = async (body) => {
    const { adminId, companyEmail } = body;
    if (!adminId) {
        throw new Error('Admin user is required to create workspace');
    }

    const companyCode = await generateWorkspaceCode(body.companyName);

    const workspace = await Workspace.create({
        ...body,
        userName: companyCode,
        companyEmail,
    });

    await User.findByIdAndUpdate(adminId, {
        $set: {
            workspaceId: workspace._id,
            userType: 'admin',
        },
    });

    await Template.insertMany(
        DEFAULT_TEMPLATES.map((t) => ({ ...t, workspaceId: workspace._id }))
    );

    return workspace;
};

const getAllWorkspacesForUser = async (userId) => {
    const user = await User.findById(userId).select('workspaceId');
    const orConditions = [{ adminId: userId }];
    if (user?.workspaceId) {
        orConditions.push({ _id: user.workspaceId });
    }

    return Workspace.find({
        $or: orConditions,
    })
        .populate('adminId', 'name email');
};

const getWorkspaceById = async (workspaceId) => {
    return Workspace.findById(workspaceId)
        .populate('adminId', 'name email');
};

const getPopulatedWorkspace = async (workspaceId) => {
    return Workspace.findById(workspaceId)
        .populate('adminId', 'name email');
};

const updateWorkspaceById = async (workspaceId, payload) => {
    return Workspace.findByIdAndUpdate(
        workspaceId,
        { $set: payload },
        { new: true, runValidators: true }
    ).populate('adminId', 'name email');
};

/**
 * Returns only the fields that actually changed between the stored workspace and the incoming payload.
 * Handles nested objects (notificationPreferences) by flattening one level.
 */
const getWorkspaceChanges = async (workspaceId, payload) => {
    const workspace = await Workspace.findById(workspaceId).lean();
    if (!workspace) return { changes: {}, message: '' };

    const FIELD_LABELS = {
        companyName: 'Company Name',
        companyEmail: 'Company Email',
        companyType: 'Company Type',
        headquarters: 'Headquarters',
        foundedYear: 'Founded Year',
        industry: 'Industry',
        employeeCount: 'Employee Count',
        currency: 'Currency',
        automationPriority: 'Automation Priority',
        initialTeamSize: 'Initial Team Size',
        expectedWorkflows: 'Expected Workflows',
        taxId: 'Tax ID',
        registrationNumber: 'Registration Number',
        timezone: 'Timezone',
        website: 'Website',
        phoneNumber: 'Phone Number',
        primaryWorkflowTypes: 'Primary Workflow Types',
        'notificationPreferences.email': 'Email Notifications',
        'notificationPreferences.slack': 'Slack Notifications',
        'notificationPreferences.teams': 'Teams Notifications',
        'notificationPreferences.inApp': 'In-App Notifications',
    };

    const changes = {};
    const changedLabels = [];

    for (const [key, newVal] of Object.entries(payload)) {
        if (key === 'notificationPreferences' && newVal && typeof newVal === 'object') {
            for (const [subKey, subVal] of Object.entries(newVal)) {
                const oldSubVal = (workspace.notificationPreferences || {})[subKey];
                if (JSON.stringify(oldSubVal) !== JSON.stringify(subVal)) {
                    changes[`notificationPreferences.${subKey}`] = { from: oldSubVal, to: subVal };
                    changedLabels.push(FIELD_LABELS[`notificationPreferences.${subKey}`] || subKey);
                }
            }
        } else {
            const oldVal = workspace[key];
            if (JSON.stringify(oldVal) !== JSON.stringify(newVal)) {
                changes[key] = { from: oldVal, to: newVal };
                changedLabels.push(FIELD_LABELS[key] || key);
            }
        }
    }

    const message = changedLabels.length
        ? `Updated: ${changedLabels.join(', ')}`
        : 'No changes detected';

    return { changes, message };
};

const addMemberToWorkspace = async () => {
    throw new Error('Members are disabled for company workspace');
};

const updateMemberRoleInWorkspace = async () => {
    throw new Error('Members are disabled for company workspace');
};

const removeMemberFromWorkspace = async () => {
    throw new Error('Members are disabled for company workspace');
};

const getWorkspaceOverview = async ({ workspaceId }) => {
    const [members, activeProcesses, pendingProcesses, completedProcesses, recentActivities, storage] = await Promise.all([
        User.find({ workspaceId })
            .select('name email role userType invitationStatus profilePicture lastActive createdAt')
            .lean(),
        Process.find({ workspaceId, status: 'inprogress' })
            .select('name description category visibility assignees status createdAt updatedAt')
            .populate('assignees', 'name email role')
            .lean(),
        Process.find({ workspaceId, status: 'draft' })
            .select('name description category visibility assignees status createdAt updatedAt')
            .populate('assignees', 'name email role')
            .lean(),
        Process.find({ workspaceId, status: 'completed' })
            .select('name description category visibility assignees status createdAt updatedAt')
            .populate('assignees', 'name email role')
            .lean(),
        ActivityLog.find({ workspaceId })
            .sort({ createdAt: -1 })
            .limit(5)
            .populate('userId', 'name email profilePicture')
            .lean(),
        getWorkspaceStorageUsage(workspaceId),
    ]);

    return {
        storage,
        members: {
            total: members.length,
            // data: members,
        },
        processes: {
            active: {
                total: activeProcesses.length,
                // data: activeProcesses,
            },
            pending: {
                total: pendingProcesses.length,
                // data: pendingProcesses,
            },
            completed: {
                total: completedProcesses.length,
                // data: completedProcesses,
            },
        },
        recentActivities,
    };
};

module.exports = {
    createNewWorkspace,
    getPopulatedWorkspace,
    updateWorkspaceById,
    getWorkspaceChanges,
    removeMemberFromWorkspace,
    addMemberToWorkspace,
    getWorkspaceById,
    updateMemberRoleInWorkspace,
    getAllWorkspacesForUser,
    getWorkspaceOverview,
};
