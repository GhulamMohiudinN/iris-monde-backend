const httpStatus = require("http-status");
const ApiError = require("./ApiError");

/**
 * Builds a multer fileFilter that only accepts the given extensions.
 *
 * Deliberately extension-based rather than MIME-based: browsers report wildly
 * inconsistent MIME types for the formats this app accepts (a .csv arrives as
 * text/csv, application/vnd.ms-excel or text/plain depending on the OS; .zip as
 * application/zip or application/x-zip-compressed), so a MIME allowlist would
 * reject legitimate files. The extension list here mirrors the `accept`
 * attribute already used on the matching file input, so this enforces on the
 * server what the UI already restricts on the client.
 *
 * @param {string[]} allowedExtensions e.g. ["pdf", "docx"]
 */
const buildFileFilter = (allowedExtensions) => {
  const allowed = allowedExtensions.map((ext) => ext.toLowerCase().replace(/^\./, ""));

  return (req, file, cb) => {
    const name = file.originalname || "";
    const ext = name.includes(".") ? name.split(".").pop().toLowerCase() : "";

    if (allowed.includes(ext)) return cb(null, true);

    return cb(
      new ApiError(
        httpStatus.BAD_REQUEST,
        `"${name}" isn't an accepted file type. Allowed: ${allowed.map((e) => `.${e}`).join(", ")}`
      )
    );
  };
};

module.exports = { buildFileFilter };
