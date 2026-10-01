#!/usr/bin/env node
/**
 * Create (or promote) a platform operator
 * ----------------------------------------
 * The platform-owner role is the only account that can create client
 * companies. It is deliberately unreachable through the API — no request can
 * grant it — so this script is the only way it is ever set. That is the whole
 * security argument for the role: there is no escalation path to find.
 *
 * The script never sets or learns a password. It creates the account and
 * sends the standard password-reset email, so the operator chooses their own.
 *
 * Usage:
 *   node scripts/createPlatformOwner.js --email a@b.com --name "Khadym Gueye"
 *   node scripts/createPlatformOwner.js --email a@b.com --name "K" --dry-run
 *   node scripts/createPlatformOwner.js --email a@b.com --force   (promote a workspace admin — see the warning below)
 */

"use strict";

require("dotenv").config({ path: require("path").resolve(__dirname, "../.env") });

const mongoose = require("mongoose");
const { User } = require("../src/models");
const { generateUniqueUsername } = require("../src/modules/users/service");
const emailService = require("../src/services/email.service");
const crypto = require("crypto");

const MONGO_URL = process.env.MONGODB_URL;
if (!MONGO_URL) {
  console.error("[ERROR] MONGODB_URL not set in .env");
  process.exit(1);
}

const args = process.argv.slice(2);
const argOf = (flag) => {
  const i = args.indexOf(flag);
  return i === -1 ? null : args[i + 1];
};
const email = (argOf("--email") || "").trim().toLowerCase();
const name = argOf("--name") || "Platform Operator";
const dryRun = args.includes("--dry-run");
const force = args.includes("--force");

if (!email) {
  console.error("[ERROR] --email is required");
  process.exit(1);
}

async function main() {
  console.log("[INFO] Connecting to MongoDB...");
  await mongoose.connect(MONGO_URL);
  console.log("[INFO] Connected");

  const existing = await User.findOne({ email });

  if (existing) {
    if (existing.userType === "owner") {
      console.log(`\n✅ ${email} is already a platform operator. Nothing to do.`);
      await mongoose.disconnect();
      return;
    }

    // Promoting a workspace admin breaks that workspace: the platform role is
    // not a superset of the admin role, so they would immediately lose access
    // to every workspace-scoped route, and the workspace would be left
    // pointing at an administrator who can no longer administer it.
    if (existing.workspaceId && !force) {
      console.error(
        `\n[ERROR] ${email} currently administers a workspace.\n` +
        `        Promoting them would leave that workspace without a working administrator,\n` +
        `        because a platform operator has no access to workspace routes.\n` +
        `        Use a separate address for the operator account, or pass --force if you\n` +
        `        are certain that workspace is disposable.`
      );
      await mongoose.disconnect();
      process.exit(1);
    }

    console.log(`[INFO] Found existing user ${email} (userType: ${existing.userType})`);
    if (dryRun) {
      console.log(`\n[DRY RUN] Would promote ${email} to platform operator. No changes made.`);
      await mongoose.disconnect();
      return;
    }

    existing.userType = "owner";
    existing.workspaceId = null;
    await existing.save();
    console.log(`\n✅ ${email} promoted to platform operator.`);
    await mongoose.disconnect();
    return;
  }

  if (dryRun) {
    console.log(`\n[DRY RUN] Would create a platform operator for ${email} (${name}).`);
    console.log(`[DRY RUN] A password-reset email would be sent so they can set their own password.`);
    await mongoose.disconnect();
    return;
  }

  const username = await generateUniqueUsername(name);
  const owner = await User.create({
    name,
    email,
    username,
    password: crypto.randomBytes(24).toString("hex"), // placeholder — replaced below by the operator
    userType: "owner",
    role: "admin",
    isEmailVerified: true,
    invitationStatus: "accepted",
    workspaceId: null,
  });

  const resetToken = crypto.randomBytes(32).toString("hex");
  owner.resetToken = resetToken;
  owner.resetTokenExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000);
  await owner.save();

  await emailService.sendResetPasswordEmail(owner.email, resetToken);

  await mongoose.disconnect();

  console.log(`\n✅ Platform operator created: ${email}`);
  console.log(`   An email has been sent so they can set their own password (valid 24 hours).`);
  console.log(`   This script never sets or stores a password you could read.`);
}

main().catch((err) => {
  console.error("[FATAL]", err.message);
  process.exit(1);
});
