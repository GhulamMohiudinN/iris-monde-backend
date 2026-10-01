const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      trim: true,
    },
    email: {
      type: String,
      unique: true,
      required: true,
      lowercase: true,
      trim: true,
    },
    username: {
      type: String,
      required: true,
      unique: true
    },
    password: {
      type: String,
      required: true,
      minlength: 8
    },
    isEmailVerified: {
      type: Boolean,
      default: false,
    },
    resetToken: { type: String, default: "" },

    resetTokenExpiry: { type: Date, default: null },
    profilePicture: {
      type: String,
      default: null,
    },
    userType: {
      // 'owner'  — platform operator: creates client companies, belongs to no
      //            workspace, and is never set through the API (see
      //            scripts/promotePlatformOwner.js). Keeping it script-only
      //            means no request can escalate a user into it.
      // 'admin'  — administrator of one workspace.
      // 'member' — invited into one workspace.
      type: String,
      enum: ['owner', 'admin', 'member'],
      default: 'member',
      required: true,
    },
    role: {
      type: String,
      enum: ['admin', 'viewer', 'editor'],
      default: 'admin',
      required: true,
    },

    rate: {
      type: Number,
      default: 0,
    },

    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Workspace',
      default: null,
      index: true,
    },
    invitationStatus: {
      type: String,
      enum: ["pending", "accepted", "rejected", "archived"],
      default: "accepted"
    },
    lastLoggedIn: {
      type: Date,
      default: null
    },
    lastActive: {
      type: Date,
      default: null
    },
  },
  { timestamps: true }
);

userSchema.pre('save', async function (next) {
  if (this.isModified('password')) {
    this.password = await bcrypt.hash(this.password, 8);
  }
  next();
});

userSchema.statics.isEmailTaken = async function (email, excludeUserId) {
  const user = await this.findOne({ email, _id: { $ne: excludeUserId } });
  return !!user;
};


userSchema.methods.isPasswordMatch = async function (password) {
  return bcrypt.compare(password, this.password);
};

const User = mongoose.model('User', userSchema);
module.exports = User;
