const Joi = require('joi');
const { password } = require('../../validations/custom.validation');

const validateSignUpInputs = (data) => {
    const schema = Joi.object({
        email: Joi.string().required().email(),
        name: Joi.string().required(),
        password: Joi.string().required().custom(password),
        confirmPassword: Joi.string().required().valid(Joi.ref('password')).messages({
            'any.only': 'confirmPassword must match password',
        }),
    });

    const result = schema.validate(data, { abortEarly: false, stripUnknown: true });
    return {
        error: result?.error,
        msg: result?.error?.details?.[0]?.message,
        value: result?.value,
    };
};

const validateVerifyEmailInputs = (data) => {
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

const validateSignInInputs = (data) => {
    const schema = Joi.object({
        email: Joi.string().required().email(),
        password: Joi.string().required(),
    });

    const result = schema.validate(data, { abortEarly: false, stripUnknown: true });
    return {
        error: result?.error,
        msg: result?.error?.details?.[0]?.message,
        value: result?.value,
    };
};

const validateForgotPasswordInputs = (data) => {
    const schema = Joi.object({
        email: Joi.string().required().email(),
    });

    const result = schema.validate(data, { abortEarly: false, stripUnknown: true });
    return {
        error: result?.error,
        msg: result?.error?.details?.[0]?.message,
        value: result?.value,
    };
};

const validateResetPasswordInputs = (data) => {
    const schema = Joi.object({
        password: Joi.string().required().custom(password),
        confirmPassword: Joi.string().required().valid(Joi.ref('password')).messages({
            'any.only': 'confirmPassword must match password',
        }),
    });

    const result = schema.validate(data, { abortEarly: false, stripUnknown: true });
    return {
        error: result?.error,
        msg: result?.error?.details?.[0]?.message,
        value: result?.value,
    };
};

const validateUpdateUserInputs = (data) => {
    const schema = Joi.object({
        // role is deliberately absent: it grants permissions, so a user may not
        // set their own. stripUnknown drops it if a client still sends it.
        name: Joi.string().trim().min(2).optional(),
    }).min(1); // Ensure at least one field is provided

    const result = schema.validate(data, { abortEarly: false, stripUnknown: true });
    return {
        error: result?.error,
        msg: result?.error?.details?.[0]?.message,
        value: result?.value,
    };
};

const validateDeleteUserInputs = (data) => {
    const schema = Joi.object({
        userId: Joi.string().required(),
    });

    const result = schema.validate(data, { abortEarly: false, stripUnknown: true });
    return {
        error: result?.error,
        msg: result?.error?.details?.[0]?.message,
        value: result?.value,
    };
};

const validateInviteTeamMemberInputs = (data) => {
    const schema = Joi.object({
        name: Joi.string().trim().min(2).required(),
        email: Joi.string().required().email(),
        role: Joi.string().valid('admin', 'viewer', 'editor').required(),
        rate: Joi.number().min(0).optional(),
    });

    const result = schema.validate(data, { abortEarly: false, stripUnknown: true });
    return {
        error: result?.error,
        msg: result?.error?.details?.[0]?.message,
        value: result?.value,
    };
};

const validateUpdateTeamMemberInputs = (data) => {
    const schema = Joi.object({
        userId: Joi.string().required(),
        name: Joi.string().trim().min(2).required(),
        role: Joi.string().valid('admin', 'viewer', 'editor').required(),
        rate: Joi.number().min(0).optional(),
    });

    const result = schema.validate(data, { abortEarly: false, stripUnknown: true });
    return {
        error: result?.error,
        msg: result?.error?.details?.[0]?.message,
        value: result?.value,
    };
};

const validateAcceptInvitationInputs = (data) => {
    const schema = Joi.object({
        token: Joi.string().required(),
        password: Joi.string().required().custom(password),
        confirmPassword: Joi.string().required().valid(Joi.ref('password')).messages({
            'any.only': 'confirmPassword must match password',
        }),
    });

    const result = schema.validate(data, { abortEarly: false, stripUnknown: true });
    return {
        error: result?.error,
        msg: result?.error?.details?.[0]?.message,
        value: result?.value,
    };
};

const validateChangePasswordInputs = (data) => {
    const schema = Joi.object({
        oldPassword: Joi.string().required(),
        newPassword: Joi.string().required().custom(password),
        confirmPassword: Joi.string().required().valid(Joi.ref('newPassword')).messages({
            'any.only': 'confirmPassword must match newPassword',
        }),
    });

    const result = schema.validate(data, { abortEarly: false, stripUnknown: true });
    return {
        error: result?.error,
        msg: result?.error?.details?.[0]?.message,
        value: result?.value,
    };
};

const createUser = {
    body: Joi.object().keys({
        email: Joi.string().required().email(),
        password: Joi.string().required().custom(password),
        name: Joi.string().required(),
        username: Joi.string().required(),
        isEmailVerified: Joi.boolean(),
        userType: Joi.string().valid('superAdmin', 'member').default('member'),
        workspaceId: Joi.string().optional().allow(null, ''),
    }),
};

const getUser = {
    params: Joi.object().keys({}),
};

const validateGetWorkspaceUsersQuery = (data) => {
    const schema = Joi.object({
        page: Joi.number().integer().min(1).default(1),
        limit: Joi.number().integer().min(1).max(100).default(10),
        role: Joi.string().valid('admin', 'editor', 'viewer').optional(),
        search: Joi.string().optional().allow(''),
    });

    const result = schema.validate(data, { abortEarly: false, stripUnknown: true });
    return {
        error: result?.error,
        msg: result?.error?.details?.[0]?.message,
        value: result?.value,
    };
};

module.exports = {
    validateSignUpInputs,
    validateVerifyEmailInputs,
    validateSignInInputs,
    validateForgotPasswordInputs,
    validateResetPasswordInputs,
    validateUpdateUserInputs,
    validateDeleteUserInputs,
    validateInviteTeamMemberInputs,
    validateUpdateTeamMemberInputs,
    validateAcceptInvitationInputs,
    validateGetWorkspaceUsersQuery,
    validateChangePasswordInputs,
    createUser,
    getUser,
};
