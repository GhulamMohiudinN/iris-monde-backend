/**
 * Contract documents.
 *
 * A contract can now carry an uploaded PDF or Word file for the recipient to
 * read before signing. The properties that matter: the file is fingerprinted at
 * upload so the signed record proves exactly what was agreed to; its stored URL
 * never leaves the server, only short-lived signed links do; and a failed upload
 * sends nobody a link to a contract with a missing document.
 *
 * Run with: npm run test:isolation
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

process.env.JWT_SECRET = process.env.JWT_SECRET || "contract-doc-secret";

// Stubbed before the service is required: it destructures these at load time,
// and the real ones would send email and upload to the live storage account.
const emailService = require("../src/services/email.service");
const sent = [];
emailService.sendContractSignRequest = async (args) => { sent.push(args); };
emailService.sendContractSignedNotification = async () => {};

const cloudinary = require("cloudinary").v2;
cloudinary.config({ cloud_name: "testcloud", api_key: "111", api_secret: "secret" });
const uploads = [];
const destroyed = [];
let failNextUpload = false;
cloudinary.uploader.upload = async (_dataUri, opts) => {
  if (failNextUpload) { failNextUpload = false; throw new Error("storage unavailable"); }
  uploads.push(opts);
  return {
    secure_url: `https://res.cloudinary.com/testcloud/${opts.resource_type}/upload/v1/${opts.folder}/${opts.public_id}`,
    public_id: `${opts.folder}/${opts.public_id}`,
  };
};
cloudinary.uploader.destroy = async (id, opts) => { destroyed.push({ id, opts }); return { result: "ok" }; };

const { Contract } = require("../src/modules/contract/model");
const contractService = require("../src/modules/contract/service");

let mongod;
const WORKSPACE = new mongoose.Types.ObjectId();
const actor = { _id: new mongoose.Types.ObjectId(), name: "Owner", email: "owner@acme.com" };

const pdf = (text = "%PDF-1.4 terms of agreement") => {
  const buffer = Buffer.from(text);
  return { originalname: "Service Agreement.pdf", mimetype: "application/pdf", size: buffer.length, buffer };
};

const payload = (overrides = {}) => ({
  title: "Service agreement", recipientName: "Jane", recipientEmail: "jane@client.com", ...overrides,
});

test.before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
});

test.after(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

// ─── Creating ────────────────────────────────────────────────────────────────
test("a contract can be sent with a document and no typed terms", async () => {
  const file = pdf();
  const contract = await contractService.createContract({ workspaceId: WORKSPACE, payload: payload(), actor, file });

  assert.equal(contract.document.fileName, "Service Agreement.pdf");
  assert.equal(contract.content, "");
  assert.equal(uploads.at(-1).resource_type, "raw", "a PDF must not be filed as an image");
  assert.match(uploads.at(-1).public_id, /\.pdf$/, "the stored file must keep its extension");
  assert.equal(sent.at(-1).to, "jane@client.com", "the recipient is still sent their link");
});

test("the document is fingerprinted so the signed record proves what was signed", async () => {
  const file = pdf("%PDF-1.4 exact bytes that were agreed");
  const contract = await contractService.createContract({ workspaceId: WORKSPACE, payload: payload(), actor, file });

  const expected = crypto.createHash("sha256").update(file.buffer).digest("hex");
  assert.equal(contract.document.sha256, expected);
});

test("a contract with neither terms nor a document is refused", async () => {
  await assert.rejects(
    () => contractService.createContract({ workspaceId: WORKSPACE, payload: payload({ content: "  " }), actor }),
    /terms, attach a document, or both/
  );
});

test("typed terms alone still work, as before", async () => {
  const contract = await contractService.createContract({
    workspaceId: WORKSPACE, payload: payload({ content: "Pay within 14 days." }), actor,
  });
  assert.equal(contract.content, "Pay within 14 days.");
  assert.equal(contract.document?.url || "", "");
});

test("a failed upload creates nothing and emails nobody", async () => {
  const contractsBefore = await Contract.countDocuments({});
  const emailsBefore = sent.length;
  failNextUpload = true;

  await assert.rejects(
    () => contractService.createContract({ workspaceId: WORKSPACE, payload: payload(), actor, file: pdf() }),
    /storage unavailable/
  );

  assert.equal(await Contract.countDocuments({}), contractsBefore, "no half-made contract may be left behind");
  assert.equal(sent.length, emailsBefore, "the recipient must not get a link to a contract missing its document");
});

// ─── Who sees what ───────────────────────────────────────────────────────────
test("the stored file URL never leaves the server", async () => {
  const created = await contractService.createContract({ workspaceId: WORKSPACE, payload: payload(), actor, file: pdf() });

  const listed = (await contractService.listContracts({ workspaceId: WORKSPACE }))
    .find((c) => String(c._id) === String(created._id));
  assert.equal(listed.document.url, undefined, "the list must not expose the permanent URL");

  assert.equal(created.document.url, undefined, "not even in the response to whoever created it");

  const publicView = await contractService.getPublicContract({ token: created.signToken });
  assert.equal(publicView.document.url, undefined, "nor may the public signing page");
  assert.equal(publicView.document.fileName, "Service Agreement.pdf");
});

test("the signer gets short-lived signed links, without logging in", async () => {
  const created = await contractService.createContract({ workspaceId: WORKSPACE, payload: payload(), actor, file: pdf() });

  const links = await contractService.getPublicDocumentLinks({ token: created.signToken });
  for (const url of [links.viewUrl, links.downloadUrl]) {
    assert.match(url, /^https:\/\/api\.cloudinary\.com\/v1_1\/testcloud\/raw\/download\?/);
    assert.match(url, /signature=/);
    const expires = Number(new URL(url).searchParams.get("expires_at"));
    assert.ok(expires - Date.now() / 1000 <= 600, "links must expire within minutes");
  }
  assert.match(links.downloadUrl, /attachment=true/);
});

test("a wrong token gets nothing", async () => {
  await assert.rejects(
    () => contractService.getPublicDocumentLinks({ token: "not-a-real-token" }),
    /invalid or has expired/
  );
});

test("another workspace cannot fetch the document", async () => {
  const created = await contractService.createContract({ workspaceId: WORKSPACE, payload: payload(), actor, file: pdf() });
  await assert.rejects(
    () => contractService.getContractDocumentLinks({ workspaceId: new mongoose.Types.ObjectId(), contractId: created._id }),
    /Contract not found/
  );
});

// ─── Cleaning up ─────────────────────────────────────────────────────────────
test("cancelling a contract removes its document from storage", async () => {
  const created = await contractService.createContract({ workspaceId: WORKSPACE, payload: payload(), actor, file: pdf() });

  const stored = await Contract.findById(created._id).lean();
  await contractService.deleteContract({ workspaceId: WORKSPACE, contractId: created._id, actor });

  const call = destroyed.at(-1);
  assert.equal(call.id, stored.document.publicId, "the uploaded document itself must be removed");
  assert.equal(call.opts.resource_type, "raw", "destroy needs the real type, never 'auto'");
  assert.equal(await Contract.countDocuments({ _id: created._id }), 0);
});
