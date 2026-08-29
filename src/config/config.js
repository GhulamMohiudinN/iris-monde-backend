const dotenv = require("dotenv");

dotenv.config({ override: true });

const normalizeUrl = (value) => {
  if (typeof value !== "string") return undefined;
  return value
    .trim()
    .replace(/\s+$/g, "")
    .replace(/\/+/g, "/")
    .replace(/\/\/+/g, "/");
};

const normalizeMongoUrl = (value) => {
  if (typeof value !== "string") return undefined;
  return value.trim();
};

const parseUrls = (value) => {
  if (!value || typeof value !== "string") return [];
  return value
    .split(",")
    .map((item) => normalizeUrl(item))
    .filter(Boolean);
};

module.exports = {
  port: process.env.PORT,
  Frontend_URL: normalizeUrl(process.env.FRONTEND_BASE_URL),
  backendUrl: normalizeUrl(process.env.BACKEND_BASE_URL),
  Frontend_URLs: parseUrls(
    process.env.FRONTEND_BASE_URLS || process.env.FRONTEND_BASE_URL,
  ),
  secrets: {
    jwtSecretKey: process.env.JWT_SECRET,
    jwtTokenExp: process.env.JWT_TOKEN_EXPIRE,
    jwtRefreshExp: process.env.JWT_REFRESH_EXPIRE,
  },
  mongoose: {
    url: normalizeMongoUrl(process.env.MONGODB_URL),
    options: {
      useCreateIndex: true,
      useNewUrlParser: true,
      useUnifiedTopology: true,
    },
  },
  jwt: {
    secret: process.env.JWT_SECRET,
    accessExpirationMinutes: process.env.JWT_ACCESS_EXPIRATION_MINUTES,
    refreshExpirationDays: process.env.JWT_REFRESH_EXPIRATION_DAYS,
    resetPasswordExpirationMinutes:
      process.env.JWT_RESET_PASSWORD_EXPIRATION_MINUTES,
    verifyEmailExpirationMinutes:
      process.env.JWT_VERIFY_EMAIL_EXPIRATION_MINUTES,
    addMemberExpirationMinutes: process.env.JWT_ADD_MEMBER_EXPIRATION_MINUTES,
  },
  ai: {
    geminiApiKey: process.env.GEMINI_API_KEY,
    geminiModel:  process.env.GEMINI_MODEL || "gemini-3.6-flash",
  },
  email: {
    from: process.env.EMAIL_FROM || process.env.SMTP_USERNAME,
    smtp: {
      host: process.env.SMTP_HOST,
      port: process.env.SMTP_PORT,
      auth: {
        user: process.env.SMTP_USERNAME,
        pass: process.env.SMTP_PASSWORD,
      },
    },
  },
};
