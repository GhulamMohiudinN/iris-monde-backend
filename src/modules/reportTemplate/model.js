const mongoose = require("mongoose");

const reportTemplateSchema = new mongoose.Schema(
  {
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
      index: true,
    },
    name:       { type: String, required: true, trim: true },
    fileType:   { type: String, enum: ["docx", "xlsx"], required: true },
    fileName:   { type: String, required: true },
    fileSize:   { type: Number, default: 0 }, // bytes — used for real workspace storage usage
    url:        { type: String, required: true }, // Cloudinary secure_url or base64 data URI (dev fallback)
    publicId:   { type: String, default: "" },
    uploadedBy: { type: String, default: "" },
  },
  { timestamps: true }
);

const ReportTemplate = mongoose.model("ReportTemplate", reportTemplateSchema);

module.exports = { ReportTemplate };
