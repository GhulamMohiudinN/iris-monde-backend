const httpStatus = require("http-status");
const ApiError   = require("../../utils/ApiError");
const PizZip     = require("pizzip");
const Docxtemplater = require("docxtemplater");
const XLSX       = require("xlsx");
const mammoth    = require("mammoth");
const { ReportTemplate } = require("./model");
const { IrisReportingRequirement } = require("../irisReporting/model");

// ─── Cloudinary setup (same pattern as IRIS evidence files) ────────────────────
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

const MIME_BY_TYPE = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

// ─── Upload a template ──────────────────────────────────────────────────────
const uploadTemplate = async ({ workspaceId, fileBuffer, fileName, actor }) => {
  const ext = fileName.split(".").pop().toLowerCase();
  if (!["docx", "xlsx"].includes(ext)) {
    throw new ApiError(httpStatus.BAD_REQUEST, "Only .docx and .xlsx templates are supported");
  }

  let url, publicId = "";
  if (isCloudinaryReady()) {
    const dataUri = `data:${MIME_BY_TYPE[ext]};base64,${fileBuffer.toString("base64")}`;
    const result = await cloudinary.uploader.upload(dataUri, {
      folder: process.env.CLOUDINARY_FOLDER || "report_templates",
      resource_type: "raw",
      public_id: `${Date.now()}-${fileName}`,
    });
    url = result.secure_url || result.url;
    publicId = result.public_id;
  } else {
    console.warn("[ReportTemplate] Cloudinary not configured — storing template as base64 (dev fallback)");
    url = `data:${MIME_BY_TYPE[ext]};base64,${fileBuffer.toString("base64")}`;
  }

  const template = await ReportTemplate.create({
    workspaceId,
    name: fileName.replace(/\.(docx|xlsx)$/i, ""),
    fileType: ext,
    fileName,
    url,
    publicId,
    uploadedBy: actor?.name || actor?.email || "",
  });

  return template.toObject();
};

const listTemplates = async ({ workspaceId }) =>
  ReportTemplate.find({ workspaceId }).sort({ createdAt: -1 }).lean();

const deleteTemplate = async ({ workspaceId, templateId }) => {
  const template = await ReportTemplate.findOne({ _id: templateId, workspaceId });
  if (!template) throw new ApiError(httpStatus.NOT_FOUND, "Template not found");

  if (template.publicId && isCloudinaryReady()) {
    try {
      await cloudinary.uploader.destroy(template.publicId, { resource_type: "raw" });
    } catch (err) {
      console.warn("[ReportTemplate] Cloudinary delete error:", err.message);
    }
  }

  await ReportTemplate.deleteOne({ _id: templateId });
  return { id: templateId };
};

// ─── Fetch the raw template bytes, whether on Cloudinary or stored as base64 ──
const fetchTemplateBuffer = async (template) => {
  if (template.url.startsWith("data:")) {
    const base64 = template.url.split(",")[1];
    return Buffer.from(base64, "base64");
  }
  const res = await fetch(template.url);
  if (!res.ok) throw new ApiError(httpStatus.BAD_GATEWAY, "Could not download the stored template file");
  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
};

// ─── Flatten an obligation into the placeholder fields it supports ────────────
const flattenObligation = (r) => ({
  title:             r.title || "",
  source:            r.source || "",
  legislationRef:    r.legislationRef || "",
  category:          r.category || "",
  obligationType:    r.obligationType || "",
  status:            r.status || "",
  owner:             r.owner || "",
  dueDate:           r.dueDate ? new Date(r.dueDate).toLocaleDateString("en-AU", { day: "2-digit", month: "short", year: "numeric" }) : "",
  materiality:       r.materiality || "",
  reportingPeriod:   r.reportingPeriod || "",
  details:           r.details || "",
  approvalStatus:    r.approvalRequired ? (r.approvalStatus || "pending") : "not_required",
  evidenceFileNames: (r.evidenceFiles || []).map((f) => f.fileName).join(", "),
});

// ─── Generate a populated document from a template + selected obligations ────
// Returns preview data rather than an immediate download — the frontend shows
// an editable table (xlsx) or a read-only preview (docx) before the user
// actually downloads anything, via finalizeXlsx / the docx base64 included here.
const generateFromTemplate = async ({ workspaceId, templateId, obligationIds, companyName }) => {
  const template = await ReportTemplate.findOne({ _id: templateId, workspaceId });
  if (!template) throw new ApiError(httpStatus.NOT_FOUND, "Template not found");

  if (!Array.isArray(obligationIds) || !obligationIds.length) {
    throw new ApiError(httpStatus.BAD_REQUEST, "Select at least one obligation to populate the template with");
  }

  const records = await IrisReportingRequirement.find({ workspaceId, _id: { $in: obligationIds } }).lean();
  if (!records.length) throw new ApiError(httpStatus.NOT_FOUND, "None of the selected obligations were found");

  const flattened = records.map(flattenObligation);
  const generatedDate = new Date().toLocaleDateString("en-AU", { day: "2-digit", month: "long", year: "numeric" });
  const fileName = `${template.name} - Generated.${template.fileType}`;

  const templateBuffer = await fetchTemplateBuffer(template);

  if (template.fileType === "docx") {
    const outputBuffer = populateDocx(templateBuffer, flattened, { companyName, generatedDate });
    let previewHtml;
    try {
      const result = await mammoth.convertToHtml({ buffer: outputBuffer });
      previewHtml = result.value;
    } catch (err) {
      console.warn("[ReportTemplate] mammoth preview conversion failed:", err.message);
      previewHtml = "<p><em>Preview unavailable — download to view.</em></p>";
    }
    return {
      fileType: "docx",
      fileName,
      previewHtml,
      fileBase64: outputBuffer.toString("base64"),
      mimeType: MIME_BY_TYPE.docx,
    };
  }

  const workbook = populateXlsx(templateBuffer, flattened, { companyName, generatedDate });
  const sheets = workbook.SheetNames.map((name) => ({
    name,
    rows: XLSX.utils.sheet_to_json(workbook.Sheets[name], { header: 1, defval: "", raw: false }),
  }));

  return { fileType: "xlsx", fileName, sheets };
};

// ─── Rebuild an .xlsx from edited sheet data (after the in-browser table edit) ──
const finalizeXlsx = ({ fileName, sheets }) => {
  if (!Array.isArray(sheets) || !sheets.length) {
    throw new ApiError(httpStatus.BAD_REQUEST, "No sheet data provided");
  }

  const workbook = XLSX.utils.book_new();
  sheets.forEach(({ name, rows }) => {
    const sheet = XLSX.utils.aoa_to_sheet(Array.isArray(rows) ? rows : []);
    XLSX.utils.book_append_sheet(workbook, sheet, (name || "Sheet1").slice(0, 31));
  });

  const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
  return { buffer, fileName: fileName || "Generated.xlsx", mimeType: MIME_BY_TYPE.xlsx };
};

// ─── Word (.docx) — full support, including {#obligations}...{/obligations} loops ──
function populateDocx(templateBuffer, obligations, { companyName, generatedDate }) {
  let zip, doc;
  try {
    zip = new PizZip(templateBuffer);
    doc = new Docxtemplater(zip, { paragraphLoop: true, linebreaks: true });
  } catch (err) {
    throw new ApiError(httpStatus.BAD_REQUEST, "This file doesn't look like a valid Word (.docx) document");
  }

  try {
    // Flat fields always resolve against the FIRST selected obligation, for
    // templates that only expect a single record (e.g. a letter template).
    // Templates listing many obligations use the {#obligations} loop instead.
    doc.render({
      ...obligations[0],
      companyName: companyName || "",
      generatedDate,
      obligations,
    });
  } catch (err) {
    const detail = err.properties?.errors?.[0]?.properties?.explanation || err.message;
    throw new ApiError(httpStatus.UNPROCESSABLE_ENTITY, `Template has a formatting issue: ${detail}`);
  }

  return doc.getZip().generate({ type: "nodebuffer" });
}

// ─── Excel (.xlsx) — single-value {tag} substitution across every cell ────────
// Note: does not repeat rows for multiple obligations — every {tag} resolves
// against the first selected obligation. Row-repeating tables are a Word-only
// capability for now (via the {#obligations} loop).
function populateXlsx(templateBuffer, obligations, { companyName, generatedDate }) {
  const values = { ...obligations[0], companyName: companyName || "", generatedDate };
  let workbook;
  try {
    workbook = XLSX.read(templateBuffer, { type: "buffer" });
  } catch (err) {
    throw new ApiError(httpStatus.BAD_REQUEST, "This file doesn't look like a valid Excel (.xlsx) document");
  }

  workbook.SheetNames.forEach((sheetName) => {
    const sheet = workbook.Sheets[sheetName];
    Object.keys(sheet).forEach((cellRef) => {
      if (cellRef.startsWith("!")) return; // skip metadata keys
      const cell = sheet[cellRef];
      if (cell.t !== "s" || typeof cell.v !== "string" || !cell.v.includes("{")) return;

      const replaced = cell.v.replace(/\{(\w+)\}/g, (match, key) =>
        Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : match
      );

      if (replaced !== cell.v) {
        cell.v = replaced;
        if (cell.w) cell.w = replaced;
      }
    });
  });

  return workbook;
}

module.exports = {
  uploadTemplate,
  listTemplates,
  deleteTemplate,
  generateFromTemplate,
  finalizeXlsx,
};
