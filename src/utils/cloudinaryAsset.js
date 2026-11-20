const crypto = require("crypto");
const cloudinary = require("cloudinary").v2;

/**
 * Helpers for files held in Cloudinary.
 *
 * Two bugs lived here before this existed.
 *
 * Evidence was opened by linking straight to the stored public URL. Uploads used
 * resource_type "auto", which files a PDF as an image, and Cloudinary blocks
 * delivery of PDF and ZIP files from image URLs by default on newer accounts —
 * so a PDF uploaded fine, appeared in the list, and then refused to open.
 * Serving a short-lived signed link through Cloudinary's authenticated download
 * API sidesteps that restriction for every file already stored, sends the
 * original file name, and stops evidence being permanently public by link.
 *
 * Deletion passed resource_type "auto" to destroy(), which accepts only image,
 * raw or video. The call failed, the failure was caught and logged, and the
 * file stayed in storage after the user was told it was gone. The real type is
 * recoverable from the stored URL, so it is read from there.
 */

const RESOURCE_TYPES = ["image", "raw", "video"];
const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp"];
const SIGNED_LINK_SECONDS = 5 * 60;

const isCloudinaryReady = () => {
  const resolved = cloudinary.config();
  return !!(resolved.cloud_name && resolved.api_key && resolved.api_secret);
};

/** The resource type an upload should use, decided from the file name. */
const uploadResourceType = (fileName = "") => {
  const ext = String(fileName).split(".").pop().toLowerCase();
  // Documents go up as raw files. Filed as images they inherit the PDF/ZIP
  // delivery block and get image processing they never use.
  return IMAGE_EXTENSIONS.includes(ext) ? "image" : "raw";
};

/**
 * Upload options that keep a readable, correctly-extended name.
 *
 * Files arrive as data URIs, so Cloudinary has no original name to work from
 * and would assign a random id. For raw files the id is the file name on
 * download, so a random one arrives with no extension and will not open.
 */
const uploadOptions = (fileName = "file", folder) => {
  const resourceType = uploadResourceType(fileName);
  const ext = String(fileName).includes(".") ? String(fileName).split(".").pop().toLowerCase() : "";
  const base = String(fileName)
    .replace(/\.[^.]+$/, "")
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60) || "file";
  const unique = `${base}_${crypto.randomBytes(4).toString("hex")}`;

  return {
    folder,
    resource_type: resourceType,
    // Images get their format appended by Cloudinary; raw ids must carry it.
    public_id: resourceType === "raw" && ext ? `${unique}.${ext}` : unique,
  };
};

/**
 * Works out what Cloudinary needs to address a stored file, from its URL.
 * Returns null for anything not held in Cloudinary — notably the base64 data
 * URIs written by the development fallback when storage was not configured.
 */
const describeAsset = (url, storedPublicId = "") => {
  if (!url || typeof url !== "string" || url.startsWith("data:")) return null;

  const match = url.match(/\/(image|raw|video)\/(upload|private|authenticated)\/(?:v\d+\/)?(.+)$/);
  if (!match) return null;

  const [, resourceType, type, rest] = match;
  const path = decodeURIComponent(rest.split("?")[0]);

  if (resourceType === "raw") {
    // Raw public ids keep their extension; there is no separate format.
    return { resourceType, type, publicId: storedPublicId || path, format: "" };
  }

  const dot = path.lastIndexOf(".");
  const format = dot > -1 ? path.slice(dot + 1) : "";
  const publicId = storedPublicId || (dot > -1 ? path.slice(0, dot) : path);
  return { resourceType, type, publicId, format };
};

/** A link that expires in a few minutes and works however the account is configured. */
const signedDownloadUrl = (asset, { attachment = true } = {}) => {
  if (!asset || !RESOURCE_TYPES.includes(asset.resourceType)) return null;
  return cloudinary.utils.private_download_url(asset.publicId, asset.format, {
    resource_type: asset.resourceType,
    type: asset.type || "upload",
    attachment,
    expires_at: Math.floor(Date.now() / 1000) + SIGNED_LINK_SECONDS,
  });
};

/**
 * Removes a stored file. Returns true if removed, false if there was nothing in
 * Cloudinary to remove; throws if Cloudinary refused, so callers can decide
 * whether that should block what they are doing.
 */
const destroyAsset = async (url, storedPublicId = "") => {
  const asset = describeAsset(url, storedPublicId);
  if (!asset || !isCloudinaryReady()) return false;

  const result = await cloudinary.uploader.destroy(asset.publicId, {
    resource_type: asset.resourceType,
    type: asset.type || "upload",
    invalidate: true,
  });
  if (result?.result !== "ok" && result?.result !== "not found") {
    throw new Error(`storage refused to delete ${asset.publicId}: ${result?.result || "no response"}`);
  }
  return result.result === "ok";
};

module.exports = {
  isCloudinaryReady,
  uploadResourceType,
  uploadOptions,
  describeAsset,
  signedDownloadUrl,
  destroyAsset,
  SIGNED_LINK_SECONDS,
};
