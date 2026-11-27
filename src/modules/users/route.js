const express = require('express');
const auth = require('../../middlewares/auth');
const { isSuperAdmin } = require('../../middlewares/auth');
const userController = require('./controller');

const router = express.Router();

router
    .post('/signup', userController.signUp)
    .post('/verify-email/:token', userController.verifyEmail)
    .post('/accept-invitation', userController.acceptInvitation)
    .post('/signin', userController.signIn)
    .post('/forgot-password', userController.forgotPassword)
    .post('/reset-password/:token', userController.resetPassword)
    .post('/invite-team-members', auth(), isSuperAdmin(), userController.inviteTeamMember)
    .patch('/update-team-members/:userId', auth(), isSuperAdmin(), userController.updateTeamMember)
    .get('/workspace-users', auth(), userController.getWorkspaceUsers)
    .get('/profile', auth(), userController.getMyProfile)
    .patch('/update-user', auth(), userController.updateUser)
    .post('/change-password', auth(), userController.changePassword)
    .delete('/delete-user/:userId', auth(), isSuperAdmin(), userController.deleteUser)

module.exports = router;

