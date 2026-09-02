const mongoose = require("mongoose");

const CONTRACT_STATUS = ["pending", "signed", "cancelled"];

const contractSchema = new mongoose.Schema(
  {
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
      index: true,
    },

    title:   { type: String, required: true, trim: true },
    content: { type: String, required: true, trim: true },

    recipientName:  { type: String, required: true, trim: true },
    recipientEmail: { type: String, required: true, trim: true, lowercase: true },

    // Who gets notified the moment this is signed.
    ownerName:  { type: String, default: "" },
    ownerEmail: { type: String, required: true, trim: true, lowercase: true },
    createdBy:  { type: mongoose.Schema.Types.ObjectId, ref: "User" },

    status: { type: String, enum: CONTRACT_STATUS, default: "pending" },

    // Random, unguessable — this token IS the authorization for the public
    // sign link, so no login is required to view/sign a contract.
    signToken: { type: String, required: true, unique: true, index: true },

    signature:  { type: String, default: "" }, // Cloudinary URL (or base64 data URI dev fallback)
    signerName: { type: String, default: "" }, // typed full name, alongside the drawn signature
    signedAt:   { type: Date, default: null },
    signerIp:   { type: String, default: "" },
  },
  { timestamps: true }
);

const Contract = mongoose.model("Contract", contractSchema);

module.exports = { Contract, CONTRACT_STATUS };
