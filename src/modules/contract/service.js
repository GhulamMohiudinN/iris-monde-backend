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
const {
  uploadOptions,
  describeAsset,
  signedDownloadUrl,
  destroyAsset,
} = require("../../utils/cloudinaryAsset");
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

// The stored URL is never sent out: links are minted per request and expire,
// so a contract document is not readable forever by whoever once saw the link.
const documentSummary = (c) =>
  c.document?.url
    ? {
        fileName: c.document.fileName,
        fileType: c.document.fileType,
        fileSize: c.document.fileSize,
        sha256:   c.document.sha256,
      }
    : null;

const documentLinks = (c) => {
  if (!c.document?.url) return null;
  if (c.document.url.startsWith("data:")) {
    return { fileName: c.document.fileName, dataUrl: c.document.url };
  }
  const asset = describeAsset(c.document.url, c.document.publicId);
  if (!asset) return null;
  return {
    fileName:    c.document.fileName,
    viewUrl:     signedDownloadUrl(asset, { attachment: false }),
    downloadUrl: signedDownloadUrl(asset, { attachment: true }),
  };
};

const publicFields = (c) => ({
  id:             c._id,
  title:          c.title,
  content:        c.content,
  document:       documentSummary(c),
  recipientName:  c.recipientName,
  ownerName:      c.ownerName,
  status:         c.status,
  signature:      c.signature,
  signerName:     c.signerName,
  signedAt:       c.signedAt,
});

// ─── Create + send ──────────────────────────────────────────────────────────
const uploadContractDocument = async (file) => {
  const sha256 = crypto.createHash("sha256").update(file.buffer).digest("hex");
  const base = {
    fileName: file.originalname,
    fileType: file.mimetype,
    fileSize: file.size,
    sha256,
  };

  if (!isCloudinaryReady()) {
    console.warn("[Contract] Cloudinary not configured — storing document as base64 (dev fallback)");
    return { ...base, url: `data:${file.mimetype};base64,${file.buffer.toString("base64")}`, publicId: "" };
  }

  const result = await cloudinary.uploader.upload(
    `data:${file.mimetype};base64,${file.buffer.toString("base64")}`,
    uploadOptions(file.originalname, process.env.CLOUDINARY_CONTRACT_FOLDER || "contracts")
  );
  return { ...base, url: result.secure_url || result.url, publicId: result.public_id };
};

const createContract = async ({ workspaceId, payload, actor, file }) => {
  const { title, content, recipientName, recipientEmail } = payload;
  if (!title?.trim() || !recipientName?.trim() || !recipientEmail?.trim()) {
    throw new ApiError(httpStatus.BAD_REQUEST, "title, recipientName and recipientEmail are required");
  }
  if (!content?.trim() && !file) {
    throw new ApiError(httpStatus.BAD_REQUEST, "Add the contract terms, attach a document, or both");
  }

  // Uploaded before the record exists, so a failed upload sends nothing and
  // leaves nothing behind — the recipient never gets a link to a contract
  // whose document is missing.
  const document = file ? await uploadContractDocument(file) : undefined;

  const signToken = crypto.randomBytes(24).toString("hex");

  const contract = await Contract.create({
    workspaceId,
    title:          title.trim(),
    content:        (content || "").trim(),
    document,
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

  const created = contract.toObject();
  return { ...created, document: documentSummary(created) };
};

// ─── List / Get (workspace-scoped, authenticated) ────────────────────────────
const listContracts = async ({ workspaceId }) => {
  const contracts = await Contract.find({ workspaceId }).sort({ createdAt: -1 }).lean();
  return contracts.map((c) => ({ ...c, document: documentSummary(c) }));
};

const getContract = async ({ workspaceId, contractId }) => {
  const contract = await Contract.findOne({ _id: contractId, workspaceId }).lean();
  if (!contract) throw new ApiError(httpStatus.NOT_FOUND, "Contract not found");
  return { ...contract, document: documentSummary(contract), documentLinks: documentLinks(contract) };
};

const getContractDocumentLinks = async ({ workspaceId, contractId }) => {
  const contract = await Contract.findOne({ _id: contractId, workspaceId }).lean();
  if (!contract) throw new ApiError(httpStatus.NOT_FOUND, "Contract not found");
  const links = documentLinks(contract);
  if (!links) throw new ApiError(httpStatus.NOT_FOUND, "This contract has no attached document");
  return links;
};

const deleteContract = async ({ workspaceId, contractId, actor }) => {
  const contract = await Contract.findOne({ _id: contractId, workspaceId });
  if (!contract) throw new ApiError(httpStatus.NOT_FOUND, "Contract not found");
  if (contract.status === "signed") {
    throw new ApiError(httpStatus.BAD_REQUEST, "A signed contract cannot be deleted — it's the record of what was agreed to.");
  }

  if (contract.document?.url) {
    try {
      await destroyAsset(contract.document.url, contract.document.publicId);
    } catch (err) {
      console.warn("[Contract] could not remove document from storage:", err.message);
    }
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

// Fetched when the signer clicks, not when the page loads, so someone who reads
// for a while before opening the file does not hit an expired link.
const getPublicDocumentLinks = async ({ token }) => {
  const contract = await Contract.findOne({ signToken: token }).lean();
  if (!contract) throw new ApiError(httpStatus.NOT_FOUND, "This link is invalid or has expired.");
  const links = documentLinks(contract);
  if (!links) throw new ApiError(httpStatus.NOT_FOUND, "This contract has no attached document");
  return links;
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
  getContractDocumentLinks,
  deleteContract,
  getPublicContract,
  getPublicDocumentLinks,
  signContract,
};
