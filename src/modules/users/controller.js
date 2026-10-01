const httpStatus = require("http-status");
const ApiError = require("../../utils/ApiError");
const catchAsync = require("../../utils/catchAsync");
const userService = require("./service");
const userValidation = require("./valadition");
const config = require("../../config/config");
const {
  workspaceService,
  authService,
  emailService,
} = require("../../services");
const { logActivity } = require("../activityLog/service");
const { ACTIVITY_ACTIONS } = require("../activityLog/model");

const signUp = catchAsync(async (req, res) => {
  // Access is invitation-only: companies are created by a platform operator,
  // who invites the administrator. Enforced here rather than by unmounting the
  // route so that the response explains itself instead of returning a 404.
  if (!config.allowPublicSignup) {
    return res.status(httpStatus.FORBIDDEN).send({
      isSuccess: false,
      message:
        'Accounts are created by invitation only. Please contact your administrator for access.',
    });
  }

  const validationResult = userValidation.validateSignUpInputs(req.body);
  if (validationResult?.error) {
    return res.status(httpStatus.BAD_REQUEST).send({
      isSuccess: false,
      message: validationResult.msg,
    });
  }

  const user = await userService.createSignUpUser(validationResult.value);
  res.status(httpStatus.CREATED).send({
    message: "Signup successful. Please verify your email to continue.",
    user,
  });
});

const signIn = catchAsync(async (req, res) => {
  console.log("SignIn request body:", req.body);
  const validationResult = userValidation.validateSignInInputs(req.body);
  if (validationResult?.error) {
    console.log("Validation error:", validationResult.msg);
    return res.status(httpStatus.BAD_REQUEST).send({
      isSuccess: false,
      message: validationResult.msg,
    });
  }

  const { email, password } = validationResult.value;
  let user;
  try {
    user = await authService.loginUserWithEmailAndPassword(email, password);
  } catch (error) {
    return res.status(httpStatus.BAD_REQUEST).send({
      isSuccess: false,
      message: error.message,
    });
  }

  if (!user.isEmailVerified) {
    return res.status(httpStatus.FORBIDDEN).send({
      isSuccess: false,
      message: "Please verify your email before sign in.",
    });
  }

  const authData = await userService.buildAuthResponse(user);
  const workspace = user.workspaceId
    ? await workspaceService.getWorkspaceById(user.workspaceId)
    : null;

  return res.send({
    success: true,
    ...authData,
    workspace,
  });
});

const forgotPassword = catchAsync(async (req, res) => {
  const validationResult = userValidation.validateForgotPasswordInputs(
    req.body,
  );
  if (validationResult?.error) {
    return res.status(httpStatus.BAD_REQUEST).send({
      isSuccess: false,
      message: validationResult.msg,
    });
  }

  const { user, resetToken } = await userService.createForgotPasswordToken(
    validationResult.value.email,
  );
  await emailService.sendResetPasswordEmail(user.email, resetToken);

  return res.send({
    success: true,
    message: "Reset password link sent to email.",
  });
});

const resetPassword = catchAsync(async (req, res) => {
  const validationResult = userValidation.validateResetPasswordInputs(req.body);
  if (validationResult?.error) {
    return res.status(httpStatus.BAD_REQUEST).send({
      isSuccess: false,
      message: validationResult.msg,
    });
  }

  const result = await userService.resetPasswordByToken({
    token: req.params.token,
    password: validationResult.value.password,
  });

  return res.send({
    success: true,
    message: "Password reset successful.",
    user: result,
  });
});

const verifyEmail = catchAsync(async (req, res) => {
  const validationResult = userValidation.validateVerifyEmailInputs(req.params);
  if (validationResult?.error) {
    return res.status(httpStatus.BAD_REQUEST).send({
      isSuccess: false,
      message: validationResult.msg,
    });
  }

  const verificationData = await userService.verifyEmailToken(
    validationResult.value.token,
  );
  res.send({
    success: true,
    message: "Email verified successfully.",
    ...verificationData,
  });
});

const createUser = catchAsync(async (req, res) => {
  const user = await userService.createUser(req.body);
  res.status(httpStatus.CREATED).send(user);
});

const getUser = catchAsync(async (req, res) => {
  const user = await userService.getUserById(req.user.id);
  if (!user) {
    throw new ApiError(httpStatus.NOT_FOUND, "User not found");
  }
  const workspace = await workspaceService.getAllWorkspacesForUser(user._id);
  res.send({ user, workspace });
});

const getWorkspaceUsers = catchAsync(async (req, res) => {
  if (!req.user?.workspaceId) {
    return res.status(httpStatus.BAD_REQUEST).send({
      isSuccess: false,
      message: "No active workspace found for user.",
    });
  }

  const validationResult = userValidation.validateGetWorkspaceUsersQuery(
    req.query,
  );
  if (validationResult?.error) {
    return res.status(httpStatus.BAD_REQUEST).send({
      isSuccess: false,
      message: validationResult.msg,
    });
  }

  const result = await userService.getUsersByWorkspaceId({
    workspaceId: req.user.workspaceId,
    ...validationResult.value,
  });

  return res.send({
    success: true,
    analytics: result.analytics,
    total: result.total,
    page: result.page,
    limit: result.limit,
    totalPages: result.totalPages,
    users: result.users,
  });
});

const changePassword = catchAsync(async (req, res) => {
  const validationResult = userValidation.validateChangePasswordInputs(
    req.body,
  );
  if (validationResult?.error) {
    return res.status(httpStatus.BAD_REQUEST).send({
      isSuccess: false,
      message: validationResult.msg,
    });
  }

  const { oldPassword, newPassword } = validationResult.value;
  await userService.changeUserPassword(req.user._id, {
    oldPassword,
    newPassword,
  });

  await logActivity({
    workspaceId: req.user.workspaceId,
    actor: req.user,
    action: ACTIVITY_ACTIONS.UPDATE_MEMBER, // Using existing action
    entityType: "user",
    entityId: req.user._id,
    message: `${req.user.name || req.user.email} changed their password`,
    data: { userId: req.user._id },
  });

  return res.send({
    success: true,
    message: "Password changed successfully.",
  });
});

const updateUser = catchAsync(async (req, res) => {
  const validationResult = userValidation.validateUpdateUserInputs(req.body);
  if (validationResult?.error) {
    return res.status(httpStatus.BAD_REQUEST).send({
      isSuccess: false,
      message: validationResult.msg,
    });
  }

  const { name, role } = validationResult.value;

  const updatedUser = await userService.updateUserById(
    req.user._id,
    validationResult.value,
  );

  // Activity logging
  await logActivity({
    workspaceId: req.user.workspaceId,
    actor: req.user,
    action: ACTIVITY_ACTIONS.UPDATE_MEMBER,
    entityType: "user",
    entityId: updatedUser._id,
    message: `${req.user.name || req.user.email} updated their profile information`,
    data: {
      updatedFields: Object.keys(validationResult.value),
      name: updatedUser.name,
      role: updatedUser.role,
    },
  });

  return res.send({
    success: true,
    user: {
      id: updatedUser._id,
      name: updatedUser.name,
      email: updatedUser.email,
      username: updatedUser.username,
      role: updatedUser.role,
      userType: updatedUser.userType,
      workspaceId: updatedUser.workspaceId,
    },
  });
});

const deleteUser = catchAsync(async (req, res) => {
  const validationResult = userValidation.validateDeleteUserInputs(req.params);
  if (validationResult?.error) {
    return res.status(httpStatus.BAD_REQUEST).send({
      isSuccess: false,
      message: validationResult.msg,
    });
  }

  await userService.deleteUserById(validationResult.value.userId);

  await logActivity({
    workspaceId: req.user.workspaceId,
    actor: req.user,
    action: ACTIVITY_ACTIONS.REMOVE_MEMBER,
    entityType: "user",
    entityId: validationResult.value.userId,
    message: `${req.user.name || req.user.email} removed a team member from the workspace`,
    data: { userId: validationResult.value.userId },
  });

  return res.send({
    success: true,
    message: "User deleted successfully.",
  });
});

const inviteTeamMember = catchAsync(async (req, res) => {
  const validationResult = userValidation.validateInviteTeamMemberInputs(
    req.body,
  );
  if (validationResult?.error) {
    return res.status(httpStatus.BAD_REQUEST).send({
      isSuccess: false,
      message: validationResult.msg,
    });
  }

  const member = await userService.inviteTeamMember({
    adminUser: req.user,
    payload: validationResult.value,
  });

  await logActivity({
    workspaceId: req.user.workspaceId,
    actor: req.user,
    action: ACTIVITY_ACTIONS.INVITE_MEMBER,
    entityType: "user",
    entityId: member.id,
    message: `${req.user.name || req.user.email} invited ${member.name} (${member.email}) as ${member.role}`,
    data: { name: member.name, email: member.email, role: member.role },
  });

  return res.status(httpStatus.CREATED).send({
    success: true,
    message: "Team member invited successfully.",
    user: member,
  });
});

const updateTeamMember = catchAsync(async (req, res) => {
  const validationResult = userValidation.validateUpdateTeamMemberInputs({
    ...req.body,
    userId: req.params.userId,
  });
  if (validationResult?.error) {
    return res.status(httpStatus.BAD_REQUEST).send({
      isSuccess: false,
      message: validationResult.msg,
    });
  }

  const member = await userService.updateTeamMemberBySuperAdmin({
    adminUser: req.user,
    memberId: validationResult.value.userId,
    payload: {
      name: validationResult.value.name,
      role: validationResult.value.role,
      rate: validationResult.value.rate,
    },
  });

  await logActivity({
    workspaceId: req.user.workspaceId,
    actor: req.user,
    action: ACTIVITY_ACTIONS.UPDATE_MEMBER,
    entityType: "user",
    entityId: member.id,
    message: `${req.user.name || req.user.email} updated team member ${member.name}`,
    data: { name: member.name, role: member.role, rate: member.rate },
  });

  return res.send({
    success: true,
    message: "Team member updated successfully.",
    user: member,
  });
});

const acceptInvitation = catchAsync(async (req, res) => {
  const validationResult = userValidation.validateAcceptInvitationInputs(
    req.body,
  );
  if (validationResult?.error) {
    return res.status(httpStatus.BAD_REQUEST).send({
      isSuccess: false,
      message: validationResult.msg,
    });
  }

  const member = await userService.acceptInvitationByToken(
    validationResult.value,
  );

  await logActivity({
    workspaceId: member.workspaceId,
    actor: { _id: member.id, name: member.name, email: member.email },
    action: ACTIVITY_ACTIONS.ACCEPT_INVITATION,
    entityType: "user",
    entityId: member.id,
    message: `${member.name || member.email} accepted the workspace invitation`,
    data: { role: member.role, email: member.email },
  });

  return res.send({
    success: true,
    message: "Invitation accepted successfully.",
    user: member,
  });
});

module.exports = {
  signUp,
  signIn,
  forgotPassword,
  resetPassword,
  verifyEmail,
  createUser,
  getUser,
  getWorkspaceUsers,
  updateUser,
  deleteUser,
  inviteTeamMember,
  updateTeamMember,
  acceptInvitation,
  changePassword,
};
