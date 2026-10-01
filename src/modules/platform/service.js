const crypto = require('crypto');
const httpStatus = require('http-status');
const ApiError = require('../../utils/ApiError');
const { User, Workspace } = require('../../models');
const workspaceService = require('../workspace/service');
const emailService = require('../../services/email.service');
const { generateUniqueUsername } = require('../users/service');

const MINUTE = 60 * 1000;
// Matches the team-invitation window. A company's first administrator is
// often onboarded ahead of a kick-off call, so a short window would strand
// them exactly as the ten-minute team invites used to.
const INVITATION_WINDOW_MINUTES = 7 * 24 * 60;

/**
 * Creates a client company and invites the person who will administer it.
 *
 * This is the only way a workspace comes into existence now that public
 * sign-up is closed, so it deliberately reuses workspaceService.createNewWorkspace
 * rather than writing its own: that function also seeds the default templates,
 * and a second implementation would drift from it.
 *
 * The administrator is created in the same pending state as an invited team
 * member — real password unset, email unverified — and becomes active only by
 * following the emailed link. Nothing here sets a password the operator knows.
 */
const createClientCompany = async ({ owner, payload }) => {
  const email = String(payload.adminEmail || '').trim().toLowerCase();

  const existing = await User.findOne({ email });
  if (existing) {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      'That email already belongs to an account. Use a different address for the company administrator.'
    );
  }

  const duplicateCompany = await Workspace.findOne({
    companyName: new RegExp(`^${String(payload.companyName).trim()}$`, 'i'),
  });
  if (duplicateCompany) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'A company with that name already exists.');
  }

  const invitationToken = crypto.randomBytes(32).toString('hex');
  const username = await generateUniqueUsername(payload.adminName);

  // Created before the workspace because createNewWorkspace needs an adminId
  // to attach, and it is the call that stamps workspaceId back onto this user.
  const admin = await User.create({
    name: payload.adminName,
    email,
    username,
    password: crypto.randomBytes(24).toString('hex'), // placeholder — replaced when the invitation is accepted
    role: 'admin',
    userType: 'admin',
    isEmailVerified: false,
    invitationStatus: 'pending',
    resetToken: invitationToken,
    resetTokenExpiry: new Date(Date.now() + INVITATION_WINDOW_MINUTES * MINUTE),
  });

  let workspace;
  try {
    workspace = await workspaceService.createNewWorkspace({
      adminId: admin._id,
      adminEmail: admin.email,
      companyName: payload.companyName,
      companyEmail: payload.companyEmail || email,
      industry: payload.industry,
      headquarters: payload.headquarters,
      currency: payload.currency,
    });
  } catch (err) {
    // Without this the failed attempt leaves an orphaned user behind, and the
    // duplicate-email check above would then block every retry with that address.
    await User.deleteOne({ _id: admin._id });
    throw err;
  }

  // A failed send must not fail the request. The company and its administrator
  // are already written, and a company that exists but reports failure is the
  // worst outcome available: it cannot be created again ("already exists") and
  // nothing tells the operator it is there. The email is a notification, so a
  // send failure is reported and retried through resendCompanyInvitation.
  let invitationSent = true;
  let invitationError = null;
  try {
    await emailService.sendAddMemberInvitation({
      to: admin.email,
      adminName: owner?.name || 'Reseaux Access',
      workspaceName: workspace.companyName || workspace.userName,
      token: invitationToken,
    });
  } catch (err) {
    invitationSent = false;
    invitationError = err.message;
    console.error(`[platform] invitation to ${admin.email} failed to send: ${err.message}`);
  }

  return {
    company: {
      id: workspace._id,
      companyName: workspace.companyName,
      userName: workspace.userName,
      companyEmail: workspace.companyEmail,
      createdAt: workspace.createdAt,
    },
    administrator: {
      id: admin._id,
      name: admin.name,
      email: admin.email,
      invitationStatus: admin.invitationStatus,
      invitationExpiresAt: admin.resetTokenExpiry,
    },
    invitationSent,
    invitationError,
  };
};

/**
 * Issues a fresh invitation to a company's administrator.
 *
 * Needed for two cases that would otherwise be dead ends: the original email
 * failed to send, and the invitation expired before it was used. Always mints
 * a new token rather than resending the old one, so an expired invitation
 * becomes usable again.
 */
const resendCompanyInvitation = async ({ owner, companyId }) => {
  const workspace = await Workspace.findById(companyId);
  if (!workspace) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Company not found');
  }

  const admin = await User.findById(workspace.adminId);
  if (!admin) {
    throw new ApiError(httpStatus.NOT_FOUND, 'That company has no administrator on record');
  }

  if (admin.invitationStatus === 'accepted') {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      `${admin.email} has already accepted their invitation. They can use "forgot password" if they cannot sign in.`
    );
  }

  const invitationToken = crypto.randomBytes(32).toString('hex');
  admin.resetToken = invitationToken;
  admin.resetTokenExpiry = new Date(Date.now() + INVITATION_WINDOW_MINUTES * MINUTE);
  await admin.save();

  await emailService.sendAddMemberInvitation({
    to: admin.email,
    adminName: owner?.name || 'Reseaux Access',
    workspaceName: workspace.companyName || workspace.userName,
    token: invitationToken,
  });

  return {
    email: admin.email,
    invitationExpiresAt: admin.resetTokenExpiry,
  };
};

/**
 * Every client company, with the state of its administrator — so an invitation
 * that was never accepted is visible rather than being silently forgotten.
 */
const listClientCompanies = async () => {
  const workspaces = await Workspace.find({})
    .select('companyName userName companyEmail adminId adminEmail industry createdAt')
    .sort({ createdAt: -1 })
    .lean();

  const adminIds = workspaces.map((w) => w.adminId).filter(Boolean);
  const admins = await User.find({ _id: { $in: adminIds } })
    .select('name email invitationStatus isEmailVerified lastActive')
    .lean();
  const adminById = new Map(admins.map((a) => [String(a._id), a]));

  const memberCounts = await User.aggregate([
    { $match: { workspaceId: { $in: workspaces.map((w) => w._id) } } },
    { $group: { _id: '$workspaceId', count: { $sum: 1 } } },
  ]);
  const countByWorkspace = new Map(memberCounts.map((m) => [String(m._id), m.count]));

  return workspaces.map((w) => {
    const admin = adminById.get(String(w.adminId));
    return {
      id: w._id,
      companyName: w.companyName,
      userName: w.userName,
      companyEmail: w.companyEmail,
      industry: w.industry,
      createdAt: w.createdAt,
      userCount: countByWorkspace.get(String(w._id)) || 0,
      administrator: admin
        ? {
            name: admin.name,
            email: admin.email,
            invitationStatus: admin.invitationStatus,
            isEmailVerified: admin.isEmailVerified,
            lastActive: admin.lastActive,
          }
        : null,
    };
  });
};

module.exports = {
  createClientCompany,
  resendCompanyInvitation,
  listClientCompanies,
  INVITATION_WINDOW_MINUTES,
};
