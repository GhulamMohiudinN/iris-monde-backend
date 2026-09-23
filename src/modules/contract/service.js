const crypto = require("crypto");
const httpStatus = require("http-status");
const ApiError = require("../../utils/ApiError");
const config = require("../../config/config");
const { Contract } = require("./model");
const { logActivity } = require("../activityLog/service");
const { ACTIVITY_ACTIONS } = require("../activityLog/model");
const { sendContractSignRequest, sendContractSignedNotification } = require("../../services/email.service");

// ─── Cloudinary setup (same pattern as IRIS evidence / report templates) ──────
const cloudinary = require("cloudinary").v2;
if (process.env.CLOUDINARY_URL) {
  cloudinary.config({ url: process.env.CLOUDINARY_URL });
} else if (process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET) {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key:    process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
  });
}
const isCloudinaryReady = () => {
  const resolved = cloudinary.config();
  return !!(resolved.cloud_name && resolved.api_key && resolved.api_secret);
};

const publicFields = (c) => ({
  id:             c._id,
  title:          c.title,
  content:        c.content,
  recipientName:  c.recipientName,
  ownerName:      c.ownerName,
  status:         c.status,
  signature:      c.signature,
  signerName:     c.signerName,
  signedAt:       c.signedAt,
});

// ─── Create + send ──────────────────────────────────────────────────────────
const createContract = async ({ workspaceId, payload, actor }) => {
  const { title, content, recipientName, recipientEmail } = payload;
  if (!title?.trim() || !content?.trim() || !recipientName?.trim() || !recipientEmail?.trim()) {
    throw new ApiError(httpStatus.BAD_REQUEST, "title, content, recipientName and recipientEmail are required");
  }

  const signToken = crypto.randomBytes(24).toString("hex");

  const contract = await Contract.create({
    workspaceId,
    title:          title.trim(),
    content:        content.trim(),
    recipientName:  recipientName.trim(),
    recipientEmail: recipientEmail.trim().toLowerCase(),
    ownerName:      actor?.name || "",
    ownerEmail:     actor?.email || "",
    createdBy:      actor?._id,
    signToken,
  });

  const signUrl = `${config.Frontend_URL}/sign?token=${signToken}`;
  await sendContractSignRequest({
    to:            contract.recipientEmail,
    recipientName: contract.recipientName,
    title:         contract.title,
    ownerName:     contract.ownerName,
    signUrl,
  });

  await logActivity({
    workspaceId,
    actor,
    action: ACTIVITY_ACTIONS.CREATE_CONTRACT,
    entityType: "contract",
    entityId: contract._id,
    message: `${actor?.name || actor?.email || "Someone"} sent "${contract.title}" to ${contract.recipientName} for signature`,
    data: { title: contract.title, recipientEmail: contract.recipientEmail },
  });

  return contract.toObject();
};

// ─── List / Get (workspace-scoped, authenticated) ────────────────────────────
const listContracts = async ({ workspaceId }) =>
  Contract.find({ workspaceId }).sort({ createdAt: -1 }).lean();

const getContract = async ({ workspaceId, contractId }) => {
  const contract = await Contract.findOne({ _id: contractId, workspaceId }).lean();
  if (!contract) throw new ApiError(httpStatus.NOT_FOUND, "Contract not found");
  return contract;
};

const deleteContract = async ({ workspaceId, contractId, actor }) => {
  const contract = await Contract.findOne({ _id: contractId, workspaceId });
  if (!contract) throw new ApiError(httpStatus.NOT_FOUND, "Contract not found");
  if (contract.status === "signed") {
    throw new ApiError(httpStatus.BAD_REQUEST, "A signed contract cannot be deleted — it's the record of what was agreed to.");
  }

  await Contract.deleteOne({ _id: contractId });

  await logActivity({
    workspaceId,
    actor,
    action: ACTIVITY_ACTIONS.CANCEL_CONTRACT,
    entityType: "contract",
    entityId: contractId,
    message: `${actor?.name || actor?.email || "Someone"} cancelled "${contract.title}"`,
    data: { title: contract.title },
  });

  return { id: contractId };
};

// ─── Public — no auth, the token itself is the authorization ────────────────
const getPublicContract = async ({ token }) => {
  const contract = await Contract.findOne({ signToken: token });
  if (!contract) throw new ApiError(httpStatus.NOT_FOUND, "This link is invalid or has expired.");
  return publicFields(contract);
};

const signContract = async ({ token, signatureDataUri, signerName, signerIp }) => {
  if (!signatureDataUri || !signerName?.trim()) {
    throw new ApiError(httpStatus.BAD_REQUEST, "A signature and full name are required.");
  }

  // This value is handed straight to Cloudinary, which will happily fetch a
  // remote URL if given one. Restricting it to an inline image data URI keeps
  // this public, unauthenticated endpoint from being used to make the server
  // fetch arbitrary URLs.
  if (!/^data:image\/(png|jpe?g);base64,/i.test(signatureDataUri)) {
    throw new ApiError(httpStatus.BAD_REQUEST, "Invalid signature format.");
  }

  const contract = await Contract.findOne({ signToken: token });
  if (!contract) throw new ApiError(httpStatus.NOT_FOUND, "This link is invalid or has expired.");
  if (contract.status !== "pending") {
    throw new ApiError(httpStatus.BAD_REQUEST, "This contract has already been signed.");
  }

  let signatureUrl = signatureDataUri;
  if (isCloudinaryReady()) {
    const result = await cloudinary.uploader.upload(signatureDataUri, {
      folder: process.env.CLOUDINARY_FOLDER || "contract_signatures",
      resource_type: "image",
    });
    signatureUrl = result.secure_url || result.url;
  } else {
    console.warn("[Contract] Cloudinary not configured — storing signature as base64 (dev fallback)");
  }

  contract.status     = "signed";
  contract.signature  = signatureUrl;
  contract.signerName = signerName.trim();
  contract.signedAt   = new Date();
  contract.signerIp   = signerIp || "";
  await contract.save();

  const contractsUrl = `${config.Frontend_URL}/contracts`;
  await sendContractSignedNotification({
    to:         contract.ownerEmail,
    ownerName:  contract.ownerName,
    title:      contract.title,
    signerName: contract.signerName,
    contractsUrl,
  });

  // The signer is an external party with no User account, so there's no real
  // userId to attribute this to — the log entry's userId points at the
  // contract's creator (a valid workspace member) so it satisfies the schema,
  // while userName/userEmail and the message correctly show who actually signed.
  await logActivity({
    workspaceId: contract.workspaceId,
    actor: { _id: contract.createdBy, name: contract.signerName, email: contract.recipientEmail },
    action: ACTIVITY_ACTIONS.SIGN_CONTRACT,
    entityType: "contract",
    entityId: contract._id,
    message: `${contract.signerName} signed "${contract.title}"`,
    data: { title: contract.title, signerName: contract.signerName },
  });

  return publicFields(contract);
};

module.exports = {
  createContract,
  listContracts,
  getContract,
  deleteContract,
  getPublicContract,
  signContract,
};
