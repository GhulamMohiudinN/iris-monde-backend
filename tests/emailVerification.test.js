/**
 * Email verification, after public sign-up was closed.
 *
 * Verification emails were only ever sent by createSignUpUser — the public
 * sign-up path. Closing that endpoint removed the only way an account could
 * become verified, while sign-in still refuses anyone whose isEmailVerified is
 * false and no resend route exists. Any account left unverified was therefore
 * locked out permanently, which is exactly what happened to the first operator
 * promoted from an existing account.
 *
 * Completing a password reset proves control of the mailbox, which is the only
 * thing verification ever established, so it now clears the flag too.
 *
 * Run with: npm run test:isolation
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

process.env.JWT_SECRET = process.env.JWT_SECRET || "verification-test-secret";

const { User } = require("../src/models");
const userService = require("../src/modules/users/service");
const authService = require("../src/services/auth.service");

let mongod;

const stranded = async (email) => {
  await User.deleteMany({ email });
  return User.create({
    name: "Stranded", email, username: `u-${Date.now()}`,
    password: "OldPassword123", userType: "admin",
    isEmailVerified: false,          // the state that cannot be escaped
    invitationStatus: "accepted",
  });
};

const withResetToken = async (user) => {
  const token = `reset-${Math.random().toString(36).slice(2)}`;
  user.resetToken = token;
  user.resetTokenExpiry = new Date(Date.now() + 60 * 60 * 1000);
  await user.save();
  return token;
};

test.before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
});

test.after(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

test("completing a password reset verifies the email", async () => {
  const user = await stranded("stranded@acme.test");
  assert.equal(user.isEmailVerified, false, "fixture must start unverified");

  const token = await withResetToken(user);
  await userService.resetPasswordByToken({ token, password: "BrandNewPass123" });

  const after = await User.findById(user._id);
  assert.equal(
    after.isEmailVerified, true,
    "a completed reset must clear the flag, or the account can never be signed into"
  );
});

test("the account can actually sign in afterwards", async () => {
  // The real test of the fix: not the flag, but whether the person gets in.
  const user = await stranded("locked-out@acme.test");
  const token = await withResetToken(user);
  await userService.resetPasswordByToken({ token, password: "BrandNewPass123" });

  const signedIn = await authService.loginUserWithEmailAndPassword(
    "locked-out@acme.test", "BrandNewPass123"
  );
  assert.ok(signedIn, "sign-in should succeed");
  assert.equal(signedIn.isEmailVerified, true);
});

test("an invitation also verifies, as it always did", async () => {
  const user = await User.create({
    name: "Invited", email: "invited@acme.test", username: `inv-${Date.now()}`,
    password: "Placeholder123", userType: "member",
    isEmailVerified: false, invitationStatus: "pending",
  });
  const token = await withResetToken(user);

  const accepted = await userService.acceptInvitationByToken({
    token, password: "InvitedPass123",
  });
  assert.equal(accepted.isEmailVerified, true);
});

test("a reset does not verify some other account", async () => {
  // Guard against a fix that sets the flag too broadly.
  const target = await stranded("target@acme.test");
  const bystander = await stranded("bystander@acme.test");

  const token = await withResetToken(target);
  await userService.resetPasswordByToken({ token, password: "BrandNewPass123" });

  assert.equal(
    (await User.findById(bystander._id)).isEmailVerified, false,
    "only the account whose token was used may be verified"
  );
});

test("an expired reset token verifies nothing", async () => {
  const user = await stranded("expired@acme.test");
  user.resetToken = "expired-token";
  user.resetTokenExpiry = new Date(Date.now() - 1000);
  await user.save();

  await assert.rejects(
    () => userService.resetPasswordByToken({ token: "expired-token", password: "BrandNewPass123" }),
    /invalid or expired/i
  );

  assert.equal(
    (await User.findById(user._id)).isEmailVerified, false,
    "an expired token must not be a way around verification"
  );
});
