const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const httpStatus = require('http-status');
const ApiError = require('../utils/ApiError');
const config = require('../config/config');
const { User, Workspace } = require('../models');

async function verifyJwtToken(payload) {
  try {
    return jwt.verify(payload, config.secrets.jwtSecretKey);
  } catch (err) {
    throw new ApiError(httpStatus.FORBIDDEN, 'Invalid signature');
  }
}

const auth = () => async (req, res, next) => {
  try {
    const bearer = req?.headers?.authorization;
    if (!bearer) {
      return next(new ApiError(httpStatus.BAD_REQUEST, 'Authorization header is required'));
    }

    const token = bearer.split(' ')[1] || '';
    if (!token) {
      return next(new ApiError(httpStatus.BAD_REQUEST, 'Authorization token not found'));
    }

    const decodedUser = await verifyJwtToken(token);
    if (!decodedUser) {
      return next(new ApiError(httpStatus.BAD_REQUEST, 'Token not verified'));
    }

    const user = await User.findById(decodedUser.userId).select('-password');
    if (!user) {
      return next(new ApiError(httpStatus.BAD_REQUEST, 'User not found'));
    }

    let workspace = null;
    if (user.workspaceId && mongoose.Types.ObjectId.isValid(user.workspaceId)) {
      workspace = await Workspace.findById(user.workspaceId);
    }

    req.user = user;
    req.userId = new mongoose.Types.ObjectId(user._id);
    req.workspace = workspace;

    next();
  } catch (error) {
    return next(
      new ApiError(
        httpStatus.UNAUTHORIZED,
        error?.message === 'Invalid signature' ? 'Token expired or invalid' : 'Token invalid'
      )
    );
  }
};

/**
 * Who administers a workspace: its owner, or a team member invited with the
 * Admin role.
 *
 * This used to accept userType 'admin' only — the person who created the
 * workspace. But the invite screen offers Admin as a role, and the menu shows
 * Invoicing, Contracts and the rest to anyone with role 'admin'. So a teammate
 * invited as Admin saw every admin feature in the menu and was refused by every
 * one of them. Platform operators stay excluded: they hold no workspace.
 */
const isWorkspaceAdmin = (user) =>
  user?.userType === 'admin' ||
  (user?.userType === 'member' && user?.role === 'admin' && !!user?.workspaceId);

const isSuperAdmin = () => async (req, res, next) => {
  const checkPermission = () => {
    if (isWorkspaceAdmin(req.user)) {
      return next();
    }

    return res.status(httpStatus.FORBIDDEN).send({
      isSuccess: false,
      message: 'you have not permission to do this action',
    });
  };

  if (!req.user) {
    return auth()(req, res, (err) => {
      if (err) {
        return next(err);
      }
      return checkPermission();
    });
  }

  return checkPermission();
};

/**
 * Platform operator guard — the role that creates client companies.
 *
 * Deliberately separate from isSuperAdmin rather than an extension of it. A
 * platform owner belongs to no workspace, so every workspace-scoped route
 * (which all rely on req.user.workspaceId) must keep rejecting them; and a
 * workspace admin must never reach the routes that create or list other
 * companies. Neither role inherits the other.
 */
const isPlatformOwner = () => async (req, res, next) => {
  const checkPermission = () => {
    if (req.user?.userType === 'owner') {
      return next();
    }

    return res.status(httpStatus.FORBIDDEN).send({
      isSuccess: false,
      message: 'you have not permission to do this action',
    });
  };

  if (!req.user) {
    return auth()(req, res, (err) => {
      if (err) {
        return next(err);
      }
      return checkPermission();
    });
  }

  return checkPermission();
};

/**
 * The person who owns the workspace, as opposed to an admin they invited.
 * Reserved for actions an invited admin must not be able to take against the
 * owner — creating a workspace, and deleting one with everyone in it.
 */
const isWorkspaceOwner = () => async (req, res, next) => {
  const checkPermission = () => {
    if (req.user?.userType === 'admin') {
      return next();
    }

    return res.status(httpStatus.FORBIDDEN).send({
      isSuccess: false,
      message: 'Only the owner of this workspace can do that',
    });
  };

  if (!req.user) {
    return auth()(req, res, (err) => {
      if (err) {
        return next(err);
      }
      return checkPermission();
    });
  }

  return checkPermission();
};

module.exports = auth;
module.exports.isSuperAdmin = isSuperAdmin;
module.exports.isWorkspaceAdmin = isWorkspaceAdmin;
module.exports.isWorkspaceOwner = isWorkspaceOwner;
module.exports.isPlatformOwner = isPlatformOwner;
