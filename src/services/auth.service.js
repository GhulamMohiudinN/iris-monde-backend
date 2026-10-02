const httpStatus = require('http-status');
const tokenService = require('./token.service');
const userService = require('./user.service');
const ApiError = require('../utils/ApiError');
const { tokenTypes } = require('../config/tokens');
const jwt = require('jsonwebtoken');
const config = require('../config/config');
const { User } = require('../models');
const bcrypt = require('bcryptjs');


const MINUTE = 60 * 1000;
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MINUTES = 15;

// One message for both "no such account" and "wrong password". Saying which it
// was lets anyone test an email address against the system and learn whether it
// has an account here — on a compliance product that leaks the client list.
const CREDENTIALS_REJECTED = 'Email or password is incorrect';

const minutesRemaining = (until) => Math.max(1, Math.ceil((until - Date.now()) / MINUTE));

const loginUserWithEmailAndPassword = async (email, password) => {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  const user = await userService.getUserByEmail(normalizedEmail, true);
  if (!user) {
    throw new ApiError(httpStatus.BAD_REQUEST, CREDENTIALS_REJECTED);
  }

  // Being told the account is locked does reveal it exists, which the message
  // above is careful not to. That is a deliberate trade: reaching this point
  // costs five wrong attempts per address, which the per-IP limiter already
  // makes slow, and silently refusing a correct password would be impossible
  // for a locked-out user to understand.
  if (user.lockedUntil && user.lockedUntil > new Date()) {
    throw new ApiError(
      httpStatus.TOO_MANY_REQUESTS,
      `Too many failed sign-in attempts. Try again in ${minutesRemaining(user.lockedUntil)} minute(s), or reset your password.`
    );
  }

  const isPasswordValid = await bcrypt.compare(password, user.password);
  if (!isPasswordValid) {
    const attempts = (user.failedLoginAttempts || 0) + 1;
    const update = { failedLoginAttempts: attempts, lastFailedLoginAt: new Date() };

    if (attempts >= MAX_FAILED_ATTEMPTS) {
      update.lockedUntil = new Date(Date.now() + LOCKOUT_MINUTES * MINUTE);
      update.failedLoginAttempts = 0; // the lock replaces the count until it expires
    }

    await User.findByIdAndUpdate(user._id, { $set: update });

    if (update.lockedUntil) {
      throw new ApiError(
        httpStatus.TOO_MANY_REQUESTS,
        `Too many failed sign-in attempts. This account is locked for ${LOCKOUT_MINUTES} minutes. You can reset your password to regain access sooner.`
      );
    }

    throw new ApiError(httpStatus.BAD_REQUEST, CREDENTIALS_REJECTED);
  }

  await User.findByIdAndUpdate(user._id, {
    $set: {
      lastLoggedIn: new Date(),
      lastActive: new Date(),
      // A successful sign-in clears the count, so occasional typos spread over
      // time never accumulate into a lockout for a legitimate user.
      failedLoginAttempts: 0,
      lockedUntil: null,
    },
  });

  user.password = undefined;
  return user;
};


const logout = async (refreshToken) => {
  try {
    await tokenService.verifyToken(refreshToken, tokenTypes.REFRESH);
  } catch (error) {
    throw new ApiError(httpStatus.UNAUTHORIZED, 'Invalid refresh token');
  }
};


const refreshAuth = async (refreshToken) => {
  try {
    const payload = await tokenService.verifyToken(refreshToken, tokenTypes.REFRESH);
    const user = await userService.getUserById(payload.sub);
    if (!user) {
      throw new Error();
    }
    return tokenService.generateAuthTokens(user);
  } catch (error) {
    throw new ApiError(httpStatus.UNAUTHORIZED, 'Please authenticate');
  }
};


const resetPassword = async (resetPasswordToken, newPassword) => {
  try {
    const payload = await tokenService.verifyToken(resetPasswordToken, tokenTypes.RESET_PASSWORD);
    const user = await userService.getUserById(payload.sub);
    if (!user) {
      throw new Error();
    }
    await userService.updateUserById(user.id, { password: newPassword });
  } catch (error) {
    throw new ApiError(httpStatus.UNAUTHORIZED, 'Password reset failed');
  }
};


const verifyEmail = async (verifyEmailToken) => {
  try {
    const payload = jwt.verify(verifyEmailToken, config.jwt.secret);
    if (payload) {
      return payload
    }
  } catch (error) {
    throw new ApiError(httpStatus.UNAUTHORIZED, 'Email verification failed');
  }
};

module.exports = {
  loginUserWithEmailAndPassword,
  logout,
  refreshAuth,
  resetPassword,
  verifyEmail,
};
