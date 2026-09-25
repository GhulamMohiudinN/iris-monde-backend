#!/usr/bin/env node
/**
 * Backfill obligation approvalStatus
 * --------------------------------------------
 * Mongoose does not run `pre("save")` hooks on `insertMany`, so obligations
 * created by the workspace seed and by bulk library import were stored with
 * whatever approvalStatus the schema default gave them — "not_required" —
 * even when they required approval. Those rows never appeared in the
 * Approvals tab, and the Approval column claimed no approval was needed.
 *
 * The code is fixed (both insert paths now derive it), but only for records
 * written from that point on. Existing rows stay wrong until something saves
 * them. This corrects them in place.
 *
 * It recomputes every obligation with the same function the pre-save hook
 * uses and writes back only the rows that disagree, so it converges the
 * collection to exactly what a save would have produced. Safe to re-run:
 * a second run finds nothing to do.
 *
 * Usage:
 *   node scripts/fixApprovalStatus.js --dry-run   (report only, no writes)
 *   node scripts/fixApprovalStatus.js             (apply the fix)
 */

"use strict";

require("dotenv").config({ path: require("path").resolve(__dirname, "../.env") });

const mongoose = require("mongoose");

const {
  IrisReportingRequirement,
  deriveApprovalStatus,
} = require("../src/modules/irisReporting/model");

const MONGO_URL = process.env.MONGODB_URL;
if (!MONGO_URL) {
  console.error("[ERROR] MONGODB_URL not set in .env");
  process.exit(1);
}

const dryRun = process.argv.slice(2).includes("--dry-run");

/**
 * When an obligation turns out to be fully approved, the pre-save hook would
 * stamp approvedAt with the current time. Doing that here would backdate every
 * historical approval to the day this script ran, so we use the last decision
 * actually recorded on the steps instead, and leave the field alone if the
 * steps carry no timestamps.
 */
const approvedAtFromSteps = (steps = []) => {
  const times = steps.map((s) => s.decidedAt).filter(Boolean).map((d) => new Date(d).getTime());
  return times.length ? new Date(Math.max(...times)) : null;
};

async function main() {
  console.log(`[INFO] Connecting to MongoDB...`);
  await mongoose.connect(MONGO_URL);
  console.log(`[INFO] Connected`);

  // lean() so nothing is run through the model's hooks while we are only reading
  const all = await IrisReportingRequirement.find(
    {},
    { workspaceId: 1, title: 1, approvalRequired: 1, approvalSteps: 1, approvalStatus: 1, approvedAt: 1 }
  ).lean();

  console.log(`[INFO] Obligations scanned: ${all.length}`);

  const changes = [];
  for (const doc of all) {
    const correct = deriveApprovalStatus(doc);
    if (correct === doc.approvalStatus) continue;

    const update = { approvalStatus: correct };
    if (correct === "approved" && !doc.approvedAt) {
      const at = approvedAtFromSteps(doc.approvalSteps);
      if (at) update.approvedAt = at;
    }
    changes.push({ doc, from: doc.approvalStatus, to: correct, update });
  }

  if (!changes.length) {
    console.log(`\n✅ Nothing to fix — every obligation already holds the correct approval status.`);
    await mongoose.disconnect();
    return;
  }

  // Report what we found, broken down by the transition and by workspace, so
  // the numbers can be sanity-checked against the UI before anything is written.
  const byTransition = {};
  const workspaces = new Set();
  for (const c of changes) {
    const key = `${c.from} -> ${c.to}`;
    byTransition[key] = (byTransition[key] || 0) + 1;
    workspaces.add(String(c.doc.workspaceId));
  }

  console.log(`\n[INFO] Obligations needing correction: ${changes.length}`);
  console.log(`[INFO] Workspaces affected: ${workspaces.size}`);
  for (const [transition, count] of Object.entries(byTransition)) {
    console.log(`         ${String(count).padStart(4)}  ${transition}`);
  }

  console.log(`\n[INFO] Sample:`);
  changes.slice(0, 10).forEach((c) => {
    console.log(`         ${c.from.padEnd(13)} -> ${c.to.padEnd(13)} ${String(c.doc.title).slice(0, 50)}`);
  });
  if (changes.length > 10) console.log(`         ... and ${changes.length - 10} more`);

  if (dryRun) {
    console.log(`\n[DRY RUN] No changes written. Re-run without --dry-run to apply.`);
    await mongoose.disconnect();
    return;
  }

  const result = await IrisReportingRequirement.bulkWrite(
    changes.map((c) => ({
      updateOne: { filter: { _id: c.doc._id }, update: { $set: c.update } },
    })),
    { ordered: false }
  );

  await mongoose.disconnect();

  console.log(`\n✅ Backfill complete: ${result.modifiedCount} obligations updated.`);
  console.log(`\nThe Approvals tab now reflects the obligations that actually require approval.`);
}

main().catch((err) => {
  console.error("[FATAL]", err.message);
  process.exit(1);
});
