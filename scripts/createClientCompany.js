#!/usr/bin/env node
/**
 * Create a client company from the command line
 * ----------------------------------------------
 * The same operation the platform admin screen performs, available before
 * that screen exists. It calls the identical service, so there is one
 * implementation of "create a company and invite its administrator" rather
 * than two that can drift apart.
 *
 * Usage:
 *   node scripts/createClientCompany.js --company "Acme Pty Ltd" \
 *        --admin-name "Jane Smith" --admin-email jane@acme.com
 *
 *   ... --industry "Financial Services" --hq "Melbourne, Australia" --currency AUD
 *   ... --dry-run
 */

"use strict";

require("dotenv").config({ path: require("path").resolve(__dirname, "../.env") });

const mongoose = require("mongoose");
const { User } = require("../src/models");
const platformService = require("../src/modules/platform/service");

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
const dryRun = args.includes("--dry-run");

const payload = {
  companyName: argOf("--company"),
  adminName: argOf("--admin-name"),
  adminEmail: (argOf("--admin-email") || "").trim().toLowerCase(),
  industry: argOf("--industry") || "",
  headquarters: argOf("--hq") || "",
  currency: argOf("--currency") || "",
};

const missing = ["companyName", "adminName", "adminEmail"].filter((k) => !payload[k]);
if (missing.length) {
  console.error(`[ERROR] Missing required: ${missing.join(", ")}`);
  console.error(`        node scripts/createClientCompany.js --company "Acme" --admin-name "Jane" --admin-email jane@acme.com`);
  process.exit(1);
}

async function main() {
  console.log("[INFO] Connecting to MongoDB...");
  await mongoose.connect(MONGO_URL);
  console.log("[INFO] Connected");

  console.log(`\n  Company:       ${payload.companyName}`);
  console.log(`  Administrator: ${payload.adminName} <${payload.adminEmail}>`);
  if (payload.industry) console.log(`  Industry:      ${payload.industry}`);
  if (payload.headquarters) console.log(`  Headquarters:  ${payload.headquarters}`);

  if (dryRun) {
    console.log(`\n[DRY RUN] Nothing created and no email sent.`);
    await mongoose.disconnect();
    return;
  }

  // Attributed to a real operator when one exists, so the invitation email
  // does not arrive from a name the recipient has never heard of.
  const owner = await User.findOne({ userType: "owner" }).select("name");
  if (!owner) {
    console.log(`[WARN] No platform operator exists yet — the invitation will be sent`);
    console.log(`       from the default sender name. Run scripts/createPlatformOwner.js first.`);
  }

  const result = await platformService.createClientCompany({ owner, payload });

  await mongoose.disconnect();

  console.log(`\n✅ ${result.company.companyName} created.`);
  console.log(`   Workspace code: ${result.company.userName}`);
  console.log(`   Invitation sent to ${result.administrator.email}`);
  console.log(`   Expires: ${new Date(result.administrator.invitationExpiresAt).toLocaleString()}`);
  console.log(`\n   They set their own password by following that link. Until they do,`);
  console.log(`   the account cannot be signed into.`);
}

main().catch((err) => {
  console.error("[FATAL]", err.message);
  process.exit(1);
});
