const httpStatus = require('http-status');
const { User, Workspace } = require('../../models');
const ApiError = require('../../utils/ApiError');
const config = require('../../config/config');
const crypto = require('crypto');
const emailService = require('../../services/email.service');
const jwt = require('jsonwebtoken');
const { tokenTypes } = require('../../config/tokens');

// ─── Token lifetimes ─────────────────────────────────────────────────────────
// Treated as floors, not plain defaults, deliberately: the expiry checks below
// were disabled for a long time, so the configured values (10 minutes) were
// never a real policy — nothing enforced them. Now that they're enforced, a
// 10-minute window would actively break users:
//   • the signup screen promises "the verification link will expire in 24 hours"
//   • an expired invite strands the invitee, because inviteTeamMember refuses
//     to re-invite an email that already exists
// Raising these via env still works; lowering them below the floor does not.
const MINUTE = 60 * 1000;
const VERIFY_EMAIL_WINDOW_MINUTES = Math.max(
    Number(config.jwt.verifyEmailExpirationMinutes) || 0,
    24 * 60,
);
const RESET_PASSWORD_WINDOW_MINUTES = Math.max(
    Number(config.jwt.resetPasswordExpirationMinutes) || 0,
    60,
);
const INVITATION_WINDOW_MINUTES = 7 * 24 * 60;

async function generateToken(payload) {
    const token = jwt.sign(payload, config.secrets.jwtSecretKey, {
        expiresIn: config.secrets.jwtTokenExp,
    });
    return token;
}

async function generateRefreshToken(payload) {
    const token = jwt.sign(payload, config.secrets.jwtSecretKey, {
        expiresIn: config.secrets.jwtRefreshExp,
    });
    return token;
}

const generateUniqueUsername = async (name = 'user') => {
    const base = (name || 'user')
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '') || 'user';

    let candidate = base;
    let attempt = 0;

    while (await User.findOne({ username: candidate })) {
        attempt += 1;
        candidate = `${base}_${Math.floor(1000 + Math.random() * 9000)}`;
        if (attempt > 20) {
            candidate = `${base}_${Date.now()}`;
            break;
        }
    }

    return candidate;
};

const createUser = async (userBody) => {
    const { email } = userBody;
    if (await User.isEmailTaken(email)) {
        throw new ApiError(httpStatus.BAD_REQUEST, 'Email already taken');
    }
    return User.create(userBody);
};

const createSignUpUser = async ({ email, name, password }) => {
    const existing = await User.findOne({ email });

    if (existing) {
        // Already fully onboarded — nothing to resume, just sign in.
        if (existing.workspaceId) {
            throw new ApiError(httpStatus.BAD_REQUEST, 'An account with this email already exists. Please sign in.');
        }

        // Verified but the workspace-setup wizard was never finished (tab
        // closed, browser crashed, etc.) — the account and password already
        // work, so send them to sign in and resume instead of signing up again.
        if (existing.isEmailVerified) {
            throw new ApiError(httpStatus.BAD_REQUEST, 'This email is already verified. Please sign in to finish setting up your workspace.');
        }

        // Signed up but never clicked the verification link — safe to let
        // them resume: overwrite the stale, unverified record instead of
        // permanently blocking the email forever.
        const resetToken = crypto.randomBytes(32).toString('hex');
        const resetTokenExpiry = new Date(Date.now() + VERIFY_EMAIL_WINDOW_MINUTES * MINUTE);

        existing.name = name;
        existing.password = password;
        existing.resetToken = resetToken;
        existing.resetTokenExpiry = resetTokenExpiry;
        await existing.save();

        await emailService.sendVerificationEmail(email, resetToken);

        return {
            id: existing._id,
            name: existing.name,
            email: existing.email,
            username: existing.username,
            isEmailVerified: existing.isEmailVerified,
        };
    }

    const username = await generateUniqueUsername(name);
    const resetToken = crypto.randomBytes(32).toString('hex');
    const resetTokenExpiry = new Date(Date.now() + VERIFY_EMAIL_WINDOW_MINUTES * MINUTE);

    const user = await User.create({
        name,
        email,
        password,
        username,
        userType: 'admin',
        isEmailVerified: false,
        workspaceId: null,
        invitationStatus: 'accepted',
        resetToken,
        resetTokenExpiry,
    });

    await emailService.sendVerificationEmail(email, resetToken);

    return {
        id: user._id,
        name: user.name,
        email: user.email,
        username: user.username,
        isEmailVerified: user.isEmailVerified,
    };
};

const verifyEmailToken = async (token) => {
    const user = await User.findOne({
        resetToken: token,
        resetTokenExpiry: { $gt: new Date() },
    });

    if (!user) {
        throw new ApiError(httpStatus.BAD_REQUEST, 'Invalid or expired verification token');
    }

    user.isEmailVerified = true;
    user.resetToken = '';
    user.resetTokenExpiry = null;
    user.lastActive = new Date();
    await user.save();

    return buildAuthResponse(user);
};

const buildAuthResponse = async (user) => {
    const tokenContext = {
        username: user.username,
        email: user.email,
        userId: user._id,
    };

    const jwtToken = await generateToken(tokenContext);
    const refreshToken = await generateRefreshToken(tokenContext);
    const tokenPayload = jwt.decode(jwtToken);
    const refreshPayload = jwt.decode(refreshToken);

    return {
        user: {
            id: user._id,
            name: user.name,
            email: user.email,
            username: user.username,
            isEmailVerified: user.isEmailVerified,
            userType: user.userType,
            role: user.role,
            workspaceId: user.workspaceId,
            invitationStatus: user.invitationStatus,
        },
        token: jwtToken,
        refreshToken,
        tokenExpiresAt: new Date(tokenPayload.exp * 1000),
        refreshTokenExpiresAt: new Date(refreshPayload.exp * 1000),
    };
};

const getUserById = async (id) => {
    return User.findById(id);
};

const getUserByEmail = async (email, includePassword = false) => {
    const query = User.findOne({ email });
    if (includePassword) {
        query.select('+password');
    }
    return query;
};

const updateUserById = async (userId, updateBody) => {
    const user = await getUserById(userId);
    if (!user) {
        throw new ApiError(httpStatus.NOT_FOUND, 'User not found');
    }
    if (updateBody.email && (await User.isEmailTaken(updateBody.email, userId))) {
        throw new ApiError(httpStatus.BAD_REQUEST, 'Email already taken');
    }
    Object.assign(user, updateBody);
    await user.save();
    return user;
};

const createForgotPasswordToken = async (email) => {
    const user = await User.findOne({ email });
    if (!user) {
        throw new ApiError(httpStatus.NOT_FOUND, 'User not found');
    }

    const resetToken = crypto.randomBytes(32).toString('hex');
    user.resetToken = resetToken;
    user.resetTokenExpiry = new Date(Date.now() + RESET_PASSWORD_WINDOW_MINUTES * MINUTE);
    await user.save();

    return {
        user,
        resetToken,
    };
};

const resetPasswordByToken = async ({ token, password }) => {
    const user = await User.findOne({
        resetToken: token,
        resetTokenExpiry: { $gt: new Date() },
    });

    if (!user) {
        throw new ApiError(httpStatus.BAD_REQUEST, 'Invalid or expired reset token');
    }

    user.password = password;
    user.resetToken = '';
    user.resetTokenExpiry = null;
    user.lastActive = new Date();
    await user.save();

    return {
        id: user._id,
        email: user.email,
    };
};

const getUsersByWorkspaceId = async ({ workspaceId, page = 1, limit = 10, role, search }) => {
    const filter = { workspaceId };
    if (role) filter.role = role;
    if (search) {
        filter.$or = [
            { name: { $regex: search, $options: 'i' } },
            { email: { $regex: search, $options: 'i' } },
        ];
    }

    const skip = (page - 1) * limit;

    const [users, total, analyticsRaw] = await Promise.all([
        User.find(filter)
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit)
            .select('-password -resetToken -resetTokenExpiry')
            .lean(),
        User.countDocuments(filter),
        User.aggregate([
            { $match: { workspaceId } },
            { $group: { _id: '$role', count: { $sum: 1 } } },
        ]),
    ]);

    const roleCounts = analyticsRaw.reduce((acc, { _id, count }) => {
        if (_id) acc[_id] = count;
        return acc;
    }, {});

    const analytics = {
        total: Object.values(roleCounts).reduce((s, c) => s + c, 0),
        admins: roleCounts['admin'] || 0,
        editors: roleCounts['editor'] || 0,
        viewers: roleCounts['viewer'] || 0,
    };

    return {
        users,
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
        analytics,
    };
};

const deleteUserById = async (userId) => {
    const user = await User.findById(userId);
    if (!user) {
        throw new ApiError(httpStatus.NOT_FOUND, 'User not found');
    }

    await User.findByIdAndDelete(userId);
    return { id: userId };
};

const inviteTeamMember = async ({ adminUser, payload }) => {
    if (!adminUser?.workspaceId) {
        throw new ApiError(httpStatus.BAD_REQUEST, 'Admin workspace not found');
    }

    const existing = await User.findOne({ email: payload.email });
    const invitationToken = crypto.randomBytes(32).toString('hex');
    const resetTokenExpiry = new Date(Date.now() + INVITATION_WINDOW_MINUTES * MINUTE);

    // Re-invite: the invite was never accepted (link expired, email lost, typo
    // in the role). Without this, the email is permanently unusable — the check
    // below would reject it forever and the person could never be invited again.
    if (existing) {
        const isResendable =
            existing.userType === 'member' &&
            existing.invitationStatus === 'pending' &&
            String(existing.workspaceId || '') === String(adminUser.workspaceId);

        if (!isResendable) {
            throw new ApiError(httpStatus.BAD_REQUEST, 'Email already taken');
        }

        existing.name = payload.name;
        existing.role = payload.role;
        if (payload.rate !== undefined) existing.rate = payload.rate;
        existing.resetToken = invitationToken;
        existing.resetTokenExpiry = resetTokenExpiry;
        await existing.save();

        const existingWorkspace = await Workspace.findById(adminUser.workspaceId).select('companyName userName');
        await emailService.sendAddMemberInvitation({
            to: existing.email,
            adminName: adminUser.name || 'Admin',
            workspaceName: existingWorkspace?.companyName || existingWorkspace?.userName || 'Workspace',
            token: invitationToken,
        });

        return {
            id: existing._id,
            name: existing.name,
            email: existing.email,
            username: existing.username,
            role: existing.role,
            rate: existing.rate,
            userType: existing.userType,
            workspaceId: existing.workspaceId,
            isEmailVerified: existing.isEmailVerified,
            invitationStatus: existing.invitationStatus,
        };
    }

    const username = await generateUniqueUsername(payload.name);

    const invitedMember = await User.create({
        name: payload.name,
        email: payload.email,
        role: payload.role,
        rate: payload.rate ?? 0,
        username,
        password: '12345678As',
        isEmailVerified: false,
        userType: 'member',
        invitationStatus: 'pending',
        workspaceId: adminUser.workspaceId,
        resetToken: invitationToken,
        resetTokenExpiry,
    });

    const workspace = await Workspace.findById(adminUser.workspaceId).select('companyName userName');

    await emailService.sendAddMemberInvitation({
        to: invitedMember.email,
        adminName: adminUser.name || 'Admin',
        workspaceName: workspace?.companyName || workspace?.userName || 'Workspace',
        token: invitationToken,
    });

    return {
        id: invitedMember._id,
        name: invitedMember.name,
        email: invitedMember.email,
        username: invitedMember.username,
        role: invitedMember.role,
        rate: invitedMember.rate,
        userType: invitedMember.userType,
        workspaceId: invitedMember.workspaceId,
        isEmailVerified: invitedMember.isEmailVerified,
        invitationStatus: invitedMember.invitationStatus,
    };
};

const updateTeamMemberBySuperAdmin = async ({ adminUser, memberId, payload }) => {
    if (!adminUser?.workspaceId) {
        throw new ApiError(httpStatus.BAD_REQUEST, 'Admin workspace not found');
    }

    const member = await User.findById(memberId);
    if (!member) {
        throw new ApiError(httpStatus.NOT_FOUND, 'Team member not found');
    }

    if (String(member.workspaceId || '') !== String(adminUser.workspaceId)) {
        throw new ApiError(httpStatus.FORBIDDEN, 'You can only update members from your workspace');
    }

    if (member.userType !== 'member') {
        throw new ApiError(httpStatus.BAD_REQUEST, 'Only member users can be updated from this API');
    }

    member.name = payload.name;
    member.role = payload.role;
    if (payload.rate !== undefined) {
        member.rate = payload.rate;
    }
    await member.save();

    return {
        id: member._id,
        name: member.name,
        email: member.email,
        username: member.username,
        role: member.role,
        rate: member.rate,
        userType: member.userType,
        workspaceId: member.workspaceId,
        invitationStatus: member.invitationStatus,
    };
};

const acceptInvitationByToken = async ({ token, password }) => {
    const user = await User.findOne({
        resetToken: token,
        resetTokenExpiry: { $gt: new Date() },
        userType: 'member',
    });

    if (!user) {
        throw new ApiError(httpStatus.BAD_REQUEST, 'Invalid or expired invitation token');
    }

    user.password = password;
    user.isEmailVerified = true;
    user.invitationStatus = 'accepted';
    user.resetToken = '';
    user.resetTokenExpiry = null;
    user.lastActive = new Date();
    await user.save();

    return {
        id: user._id,
        name: user.name,
        email: user.email,
        username: user.username,
        role: user.role,
        rate: user.rate,
        isEmailVerified: user.isEmailVerified,
        invitationStatus: user.invitationStatus,
        workspaceId: user.workspaceId,
        userType: user.userType,
    };
};

const changeUserPassword = async (userId, { oldPassword, newPassword }) => {
    const user = await getUserById(userId);
    if (!user) {
        throw new ApiError(httpStatus.NOT_FOUND, 'User not found');
    }

    if (!(await user.isPasswordMatch(oldPassword))) {
        throw new ApiError(httpStatus.UNAUTHORIZED, 'Incorrect old password');
    }

    user.password = newPassword;
    await user.save();

    return user;
};

module.exports = {
    createSignUpUser,
    verifyEmailToken,
    createUser,
    getUserById,
    getUserByEmail,
    updateUserById,
    createForgotPasswordToken,
    resetPasswordByToken,
    getUsersByWorkspaceId,
    buildAuthResponse,
    deleteUserById,
    inviteTeamMember,
    updateTeamMemberBySuperAdmin,
    acceptInvitationByToken,
    changeUserPassword,
};
