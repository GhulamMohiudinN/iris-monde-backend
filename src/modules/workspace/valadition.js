const Joi = require('joi');

const validateCreateWorkspaceInputs = (data) => {
    const schema = Joi.object({
        companyEmail: Joi.string().optional(),
        companyName: Joi.string().required(),
        companyType: Joi.string().required(),
        headquarters: Joi.string().required(),
        foundedYear: Joi.string().optional().allow(''),
        industry: Joi.string().required(),
        employeeCount: Joi.string().required(),
        currency: Joi.string().required(),
        automationPriority: Joi.string().optional(),
        initialTeamSize: Joi.string().optional(),
        expectedWorkflows: Joi.string().optional().allow(''),
        taxId: Joi.string().optional().allow(''),
        registrationNumber: Joi.string().optional().allow(''),
        timezone: Joi.string().optional().allow(''),
        website: Joi.string().optional().allow(''),
        phoneNumber: Joi.string().optional().allow(''),
        primaryWorkflowTypes: Joi.array().items(Joi.string()).required(),
        notificationPreferences: Joi.object({
            email: Joi.boolean(),
            slack: Joi.boolean(),
            teams: Joi.boolean(),
            inApp: Joi.boolean(),
        }).required(),
    });

    const result = schema.validate(data, { abortEarly: false, stripUnknown: true });
    return {
        error: result?.error,
        msg: result?.error?.details?.[0]?.message,
        value: result?.value,
    };
};

const validateUpdateWorkspaceInputs = (data) => {
    const schema = Joi.object({
        companyEmail: Joi.string().optional(),
        companyName: Joi.string().optional(),
        companyType: Joi.string().optional(),
        headquarters: Joi.string().optional(),
        foundedYear: Joi.string().optional().allow(''),
        industry: Joi.string().optional(),
        employeeCount: Joi.string().optional(),
        currency: Joi.string().optional(),
        automationPriority: Joi.string().optional(),
        initialTeamSize: Joi.string().optional(),
        expectedWorkflows: Joi.string().optional().allow(''),
        taxId: Joi.string().optional().allow(''),
        registrationNumber: Joi.string().optional().allow(''),
        timezone: Joi.string().optional().allow(''),
        website: Joi.string().optional().allow(''),
        phoneNumber: Joi.string().optional().allow(''),
        primaryWorkflowTypes: Joi.array().items(Joi.string()).optional(),
        billing: Joi.object({
            address:       Joi.string().allow('').optional(),
            bankName:      Joi.string().allow('').optional(),
            accountName:   Joi.string().allow('').optional(),
            bsb:           Joi.string().allow('').optional(),
            accountNumber: Joi.string().allow('').optional(),
            swift:         Joi.string().allow('').optional(),
        }).optional(),
        notificationPreferences: Joi.object({
            email: Joi.boolean(),
            slack: Joi.boolean(),
            teams: Joi.boolean(),
            inApp: Joi.boolean(),
        }).optional(),
    }).min(1);

    const result = schema.validate(data, { abortEarly: false, stripUnknown: true });
    return {
        error: result?.error,
        msg: result?.error?.details?.[0]?.message,
        value: result?.value,
    };
};

const validateAddMemberInputs = (data) => {
    const schema = Joi.object({
        memberId: Joi.string().required(),
        memberEmail: Joi.string().required(),
        permissions: Joi.object().pattern(Joi.string(), Joi.boolean()).optional(),
        customMessage: Joi.string().optional().allow(''),
        workspaceId: Joi.string().required(),
        role: Joi.string().valid('editor', 'viewer').required(),
    });

    const result = schema.validate(data, { abortEarly: false, stripUnknown: true });
    return {
        error: result?.error,
        msg: result?.error?.details?.[0]?.message,
        value: result?.value,
    };
};

const validateSendAddMemberEmailInputs = (data) => {
    const schema = Joi.object({
        workspaceId: Joi.string().required(),
        memberEmail: Joi.string().required(),
        role: Joi.string().valid('editor', 'viewer').required(),
        customMessage: Joi.string().optional().allow(''),
        permissions: Joi.object().pattern(Joi.string(), Joi.boolean()).optional(),
    });

    const result = schema.validate(data, { abortEarly: false, stripUnknown: true });
    return {
        error: result?.error,
        msg: result?.error?.details?.[0]?.message,
        value: result?.value,
    };
};

const validateVerifyInviteEmailInputs = (data) => {
    const schema = Joi.object({
        token: Joi.string().required(),
    });

    const result = schema.validate(data, { abortEarly: false, stripUnknown: true });
    return {
        error: result?.error,
        msg: result?.error?.details?.[0]?.message,
        value: result?.value,
    };
};

const validateUpdateMemberInputs = (data) => {
    const schema = Joi.object({
        workspaceId: Joi.string().required(),
        memberId: Joi.string().required(),
        role: Joi.string().valid('editor', 'viewer').required(),
    });

    const result = schema.validate(data, { abortEarly: false, stripUnknown: true });
    return {
        error: result?.error,
        msg: result?.error?.details?.[0]?.message,
        value: result?.value,
    };
};

const validateDeleteMemberInputs = (data) => {
    const schema = Joi.object({
        workspaceId: Joi.string().required(),
        memberId: Joi.string().required(),
    });

    const result = schema.validate(data, { abortEarly: false, stripUnknown: true });
    return {
        error: result?.error,
        msg: result?.error?.details?.[0]?.message,
        value: result?.value,
    };
};

module.exports = {
    validateCreateWorkspaceInputs,
    validateUpdateWorkspaceInputs,
    validateAddMemberInputs,
    validateSendAddMemberEmailInputs,
    validateVerifyInviteEmailInputs,
    validateUpdateMemberInputs,
    validateDeleteMemberInputs,
};
