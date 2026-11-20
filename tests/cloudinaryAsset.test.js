/**
 * Stored-file handling.
 *
 * Evidence is the product's proof of compliance, and two faults made it
 * unreliable: PDFs uploaded as "auto" were filed as images, which Cloudinary
 * refuses to deliver by default, so they appeared in the list and then would
 * not open; and deletion passed resource_type "auto" to destroy(), which
 * Cloudinary answers with "not found" rather than an error, so files were
 * reported deleted while staying in storage.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const cloudinary = require("cloudinary").v2;

const {
  uploadResourceType,
  uploadOptions,
  describeAsset,
  signedDownloadUrl,
  destroyAsset,
} = require("../src/utils/cloudinaryAsset");

cloudinary.config({ cloud_name: "testcloud", api_key: "111", api_secret: "secret" });

const IMAGE_PDF = "https://res.cloudinary.com/testcloud/image/upload/v1712345678/iris_reporting/abc123.pdf";
const RAW_DOCX = "https://res.cloudinary.com/testcloud/raw/upload/v1712345678/iris_reporting/Board_Minutes_9f8e.docx";
const IMAGE_PNG = "https://res.cloudinary.com/testcloud/image/upload/v1712345678/iris_reporting/scan_77aa.png";

// ─── Uploading ───────────────────────────────────────────────────────────────
test("documents upload as raw files, images as images", () => {
  for (const name of ["report.pdf", "minutes.docx", "ledger.xlsx", "data.csv", "bundle.zip"]) {
    assert.equal(uploadResourceType(name), "raw", `${name} must not be filed as an image`);
  }
  for (const name of ["scan.png", "photo.JPG", "receipt.jpeg"]) {
    assert.equal(uploadResourceType(name), "image");
  }
});

test("a raw upload keeps its extension, so the download opens", () => {
  // Files arrive as data URIs with no name, so the id has to be set explicitly.
  const opts = uploadOptions("Annual Report 2026.pdf", "iris_reporting");
  assert.equal(opts.resource_type, "raw");
  assert.match(opts.public_id, /^Annual_Report_2026_[0-9a-f]{8}\.pdf$/);
  assert.equal(opts.folder, "iris_reporting");
});

test("two uploads with the same name do not overwrite each other", () => {
  const a = uploadOptions("evidence.pdf").public_id;
  const b = uploadOptions("evidence.pdf").public_id;
  assert.notEqual(a, b);
});

test("hostile file names are reduced to something safe", () => {
  const opts = uploadOptions("../../etc/passwd<script>.pdf");
  assert.ok(!opts.public_id.includes("/"), "no path segments may survive into the id");
  assert.ok(!opts.public_id.includes("<"));
});

// ─── Reading existing files ──────────────────────────────────────────────────
test("a PDF already stored as an image is understood correctly", () => {
  // Every PDF uploaded before this fix looks like this.
  assert.deepEqual(describeAsset(IMAGE_PDF, "iris_reporting/abc123"), {
    resourceType: "image", type: "upload", publicId: "iris_reporting/abc123", format: "pdf",
  });
});

test("a raw file keeps its extension in the id and has no separate format", () => {
  assert.deepEqual(describeAsset(RAW_DOCX, "iris_reporting/Board_Minutes_9f8e.docx"), {
    resourceType: "raw", type: "upload", publicId: "iris_reporting/Board_Minutes_9f8e.docx", format: "",
  });
});

test("the id is recovered from the URL when none was stored", () => {
  assert.equal(describeAsset(IMAGE_PNG).publicId, "iris_reporting/scan_77aa");
  assert.equal(describeAsset(RAW_DOCX).publicId, "iris_reporting/Board_Minutes_9f8e.docx");
});

test("development fallback files are not mistaken for stored ones", () => {
  assert.equal(describeAsset("data:application/pdf;base64,JVBERi0="), null);
  assert.equal(describeAsset(""), null);
  assert.equal(describeAsset("https://example.com/file.pdf"), null);
});

// ─── Signed links ────────────────────────────────────────────────────────────
test("downloads go through the signed API, not the public delivery URL", () => {
  // The delivery URL is what Cloudinary blocks for PDFs; the API is not.
  const url = signedDownloadUrl(describeAsset(IMAGE_PDF, "iris_reporting/abc123"));
  assert.match(url, /^https:\/\/api\.cloudinary\.com\/v1_1\/testcloud\/image\/download\?/);
  assert.match(url, /signature=/, "the link must be signed");
  assert.match(url, /format=pdf/);
  assert.match(url, /attachment=true/);
});

test("signed links expire within minutes", () => {
  const url = signedDownloadUrl(describeAsset(RAW_DOCX));
  const expiresAt = Number(new URL(url).searchParams.get("expires_at"));
  const secondsLeft = expiresAt - Math.floor(Date.now() / 1000);
  assert.ok(secondsLeft > 0 && secondsLeft <= 600, `expected a short expiry, got ${secondsLeft}s`);
});

test("view links open in place rather than downloading", () => {
  const url = signedDownloadUrl(describeAsset(IMAGE_PDF), { attachment: false });
  assert.ok(!/attachment=true/.test(url));
});

// ─── Deleting ────────────────────────────────────────────────────────────────
test("deletion uses the file's real type, never 'auto'", async () => {
  const calls = [];
  const original = cloudinary.uploader.destroy;
  cloudinary.uploader.destroy = async (id, opts) => { calls.push({ id, opts }); return { result: "ok" }; };

  try {
    assert.equal(await destroyAsset(IMAGE_PDF, "iris_reporting/abc123"), true);
    assert.equal(await destroyAsset(RAW_DOCX), true);
  } finally {
    cloudinary.uploader.destroy = original;
  }

  assert.equal(calls[0].opts.resource_type, "image");
  assert.equal(calls[1].opts.resource_type, "raw");
  assert.ok(calls.every((c) => c.opts.resource_type !== "auto"), "'auto' is rejected by destroy()");
});

test("a refusal from storage is surfaced, not swallowed as success", async () => {
  const original = cloudinary.uploader.destroy;
  cloudinary.uploader.destroy = async () => ({ result: "error" });
  try {
    await assert.rejects(() => destroyAsset(RAW_DOCX), /refused/);
  } finally {
    cloudinary.uploader.destroy = original;
  }
});

test("a file that is already gone is not counted as deleted", async () => {
  const original = cloudinary.uploader.destroy;
  cloudinary.uploader.destroy = async () => ({ result: "not found" });
  try {
    assert.equal(await destroyAsset(RAW_DOCX), false, "'not found' is not a deletion");
  } finally {
    cloudinary.uploader.destroy = original;
  }
});
