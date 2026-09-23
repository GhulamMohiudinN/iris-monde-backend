const express = require("express");
const passport = require("passport");
const helmet = require("helmet");
const { rateLimit } = require("express-rate-limit");
const { jwtStrategy } = require("./src/config/passport");
const cors = require("cors");
const registerRoutes = require("./src/routes/app.routes");
const config = require("./src/config/config");

const app = express();

// Vercel puts a proxy in front of us — without this, every request looks like
// it comes from the same proxy IP and per-IP rate limiting would throttle all
// users as one. A number (not `true`) also keeps express-rate-limit happy.
app.set("trust proxy", 1);

// Security headers. CSP is off because this is a JSON API (CSP protects HTML
// pages, and enabling it here only risks breaking the static /public folder).
// CORP must be cross-origin since the frontend is on a different domain.
app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: "cross-origin" },
  })
);

// enable cors
const allowedOrigins = [
  ...(config.Frontend_URLs || []),
  config.backendUrl,
].filter(Boolean);

// Note: this API authenticates with Bearer tokens from localStorage, not
// cookies, so CORS is not the security boundary — it mainly stops casual
// cross-origin calls from arbitrary sites. The fallbacks below are deliberate:
// an unset/stale FRONTEND_BASE_URL must never lock the real frontend out.
if (!allowedOrigins.length) {
  console.warn(
    "[CORS] FRONTEND_BASE_URL is not set — falling back to allowing every origin. " +
      "Set it so the allow-list actually applies."
  );
}

const isAllowedOrigin = (origin) => {
  if (!origin) return true;                  // curl, server-to-server, cron — no Origin header
  if (!allowedOrigins.length) return true;   // nothing configured — don't break the app
  if (allowedOrigins.includes(origin)) return true;
  if (/^https:\/\/[a-z0-9-]+\.vercel\.app$/i.test(origin)) return true; // our deployments
  if (/^http:\/\/localhost(:\d+)?$/i.test(origin)) return true;         // local dev
  return false;
};

const corsOptions = {
  origin: (origin, callback) => callback(null, isAllowedOrigin(origin)),
  credentials: true,
};

app.use(cors(corsOptions));
app.options("*", cors(corsOptions));

// Brute-force protection on credential endpoints only.
// skipSuccessfulRequests means genuine logins never count toward the limit —
// only failed attempts accumulate, so real users can't get locked out.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  skipSuccessfulRequests: true,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: {
    isSuccess: false,
    message: "Too many attempts. Please wait a few minutes and try again.",
  },
});

app.use("/api/v1/users/signin", authLimiter);
app.use("/api/v1/users/signup", authLimiter);
app.use("/api/v1/users/forgot-password", authLimiter);
app.use("/api/v1/users/reset-password", authLimiter);

// normalize duplicate slashes in request paths
app.use((req, res, next) => {
  req.url = req.url.replace(/\/\/{2,}/g, "/");
  next();
});

// serve static files
app.use(express.static("public"));

// parse json request body.
// The 2mb limit (vs express's 100kb default) is deliberate: a drawn contract
// signature is posted as a base64 PNG data URI and can land in the 40–90kb
// range, which sits uncomfortably close to the default ceiling.
app.use(express.json({ limit: "2mb" }));

// parse urlencoded request body
app.use(express.urlencoded({ extended: true, limit: "2mb" }));

// jwt authentication
app.use(passport.initialize());
passport.use("jwt", jwtStrategy);

// root health endpoint for deployment checks
app.get("/", (req, res) => {
  res.status(200).json({
    status: "success",
    message: "Workflow backend is running",
  });
});

registerRoutes(app);

// catch unmatched routes
app.use((req, res) => {
  res.status(404).json({
    status: "error",
    message: `Route ${req.originalUrl} not found`,
  });
});

// global error handler
app.use((err, req, res, next) => {
  const status  = err.statusCode || err.status || 500;
  const message = err.message || "Internal Server Error";

  // Always log the full error in the server console so devs can diagnose
  console.error(`[Error] ${req.method} ${req.originalUrl} → ${status}: ${message}`);
  if (err.stack) console.error(err.stack);

  res.status(status).json({
    status:  status >= 500 ? "error" : "fail",
    message,
    // Only expose stack trace in development
    ...(process.env.NODE_ENV === "development" && err.stack
      ? { stack: err.stack }
      : {}),
  });
});

module.exports = app;
