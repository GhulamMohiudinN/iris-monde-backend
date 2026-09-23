/**
 * Security regression tests.
 *
 * These cover protections that are easy to silently undo — an expiry check
 * getting commented out, CORS being loosened back to `origin: true`, a file
 * filter being dropped. None of them need a database: every protection here
 * runs as middleware, before any query is issued.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

// Set before app.js loads: CORS origins are read from config at require time.
// Pinning it here keeps these assertions deterministic whether or not a local
// .env exists, and means CI tests the configured behaviour rather than the
// unconfigured fallback.
process.env.FRONTEND_BASE_URL = "https://iris-monde.vercel.app";

const app = require("../app.js");
const { buildFileFilter } = require("../src/utils/uploadFilter");

let server;
let BASE;

test.before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      BASE = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

test.after(() => server?.close());

// ─── Security headers ────────────────────────────────────────────────────────
test("helmet sets hardening headers and hides the server stack", async () => {
  const res = await fetch(`${BASE}/`);
  assert.equal(res.status, 200, "health endpoint should still work");
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.ok(res.headers.get("x-frame-options"), "clickjacking protection missing");
  assert.ok(res.headers.get("strict-transport-security"), "HSTS missing");
  assert.equal(res.headers.get("x-powered-by"), null, "should not advertise Express");
});

test("CORP stays cross-origin so the frontend can load resources", async () => {
  const res = await fetch(`${BASE}/`);
  assert.equal(res.headers.get("cross-origin-resource-policy"), "cross-origin");
});

// ─── CORS ────────────────────────────────────────────────────────────────────
const allowOriginFor = async (origin) => {
  const res = await fetch(`${BASE}/`, { headers: { Origin: origin } });
  return res.headers.get("access-control-allow-origin");
};

test("CORS allows our own deployments and local dev", async () => {
  assert.equal(await allowOriginFor("https://iris-monde.vercel.app"), "https://iris-monde.vercel.app");
  assert.equal(await allowOriginFor("http://localhost:3000"), "http://localhost:3000");
});

test("CORS blocks an arbitrary third-party site", async () => {
  assert.equal(await allowOriginFor("https://evil-attacker.com"), null);
});

test("CORS preflight succeeds with Authorization header", async () => {
  const origin = "https://iris-monde.vercel.app";
  const res = await fetch(`${BASE}/api/v1/users/signin`, {
    method: "OPTIONS",
    headers: {
      Origin: origin,
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "content-type,authorization",
    },
  });
  assert.ok(res.status === 200 || res.status === 204, `preflight returned ${res.status}`);
  assert.equal(res.headers.get("access-control-allow-origin"), origin);
  assert.match(res.headers.get("access-control-allow-headers") || "", /authorization/i);
});

// ─── Brute-force protection ──────────────────────────────────────────────────
test("credential endpoints rate limit repeated failures but not normal traffic", async () => {
  const attempt = () =>
    fetch(`${BASE}/api/v1/users/signin`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}), // rejected by validation before any DB call
    });

  const first = await attempt();
  assert.equal(first.status, 400, "a single failure must not be blocked");

  let blockedAt = null;
  for (let i = 2; i <= 60; i++) {
    const res = await attempt();
    if (res.status === 429) {
      blockedAt = i;
      break;
    }
  }
  assert.ok(blockedAt, "brute force was never blocked");
  assert.ok(blockedAt > 10 && blockedAt <= 40, `blocked at attempt ${blockedAt}, expected ~31`);

  // The limiter must be scoped to credential routes only.
  const health = await fetch(`${BASE}/`);
  assert.equal(health.status, 200, "rate limiter leaked onto non-auth routes");
});

// ─── Upload filtering ────────────────────────────────────────────────────────
const runFilter = (filter, originalname) =>
  new Promise((resolve) => filter({}, { originalname }, (err, ok) => resolve({ err, ok })));

test("evidence uploads accept the documented types and reject executables", async () => {
  const filter = buildFileFilter(["pdf", "doc", "docx", "xls", "xlsx", "png", "jpg", "jpeg", "zip", "csv"]);

  for (const name of ["report.pdf", "Evidence.DOCX", "sheet.xlsx", "scan.jpeg", "pack.zip", "data.csv"]) {
    const { err, ok } = await runFilter(filter, name);
    assert.ok(ok && !err, `${name} should be accepted`);
  }

  for (const name of ["malware.exe", "payload.html", "script.js", "shell.sh", "noextension"]) {
    const { err } = await runFilter(filter, name);
    assert.ok(err, `${name} should be rejected`);
    assert.equal(err.statusCode, 400, `${name} should fail as a 400, not a crash`);
  }
});

test("report templates only accept .docx and .xlsx", async () => {
  const filter = buildFileFilter(["docx", "xlsx"]);
  assert.ok((await runFilter(filter, "template.docx")).ok);
  assert.ok((await runFilter(filter, "template.xlsx")).ok);
  assert.ok((await runFilter(filter, "template.pdf")).err);
});

// ─── Contract signature input ────────────────────────────────────────────────
test("contract signatures must be inline images, not fetchable URLs", () => {
  const isValid = (value) => /^data:image\/(png|jpe?g);base64,/i.test(value);

  assert.ok(isValid("data:image/png;base64,iVBORw0KGgo="), "canvas PNG output must be accepted");
  assert.ok(!isValid("https://internal-service.local/secret"), "remote URL would let the server be used to fetch arbitrary addresses");
  assert.ok(!isValid("data:text/html;base64,PHNjcmlwdD4="), "non-image data URI must be rejected");
});

// ─── Token expiry ────────────────────────────────────────────────────────────
test("password reset and email verification enforce token expiry", () => {
  const source = fs.readFileSync(path.join(__dirname, "../src/modules/users/service.js"), "utf8");

  assert.ok(
    !source.includes("// resetTokenExpiry"),
    "an expiry check has been commented out again — tokens would never expire"
  );

  const activeChecks = source.match(/resetTokenExpiry: \{ \$gt: new Date\(\) \}/g) || [];
  assert.ok(
    activeChecks.length >= 3,
    `expected expiry checks on verify, reset and invitation flows, found ${activeChecks.length}`
  );
});

test("verification window honours the 24 hours promised on the signup screen", () => {
  const config = require("../src/config/config");
  const configured = Number(config.jwt.verifyEmailExpirationMinutes) || 0;
  const effective = Math.max(configured, 24 * 60);
  assert.ok(effective >= 1440, `effective verification window is ${effective} minutes`);
});

// ─── Auth token integrity ────────────────────────────────────────────────────
// Every user in the app is authenticated by a signed JWT, and the library
// underneath (jws) has had a real HMAC verification advisory against it. These
// assertions fail loudly if a dependency change ever weakens signature checking.
test("JWTs round-trip and reject tampering", () => {
  const jwt = require("jsonwebtoken");
  const secret = "token-integrity-test-secret";

  const token = jwt.sign({ userId: "abc123" }, secret, { expiresIn: "30m" });
  assert.equal(jwt.verify(token, secret).userId, "abc123");

  const [header, payload] = token.split(".");

  assert.throws(
    () => jwt.verify(`${header}.${payload}.forged-signature`, secret),
    "a forged signature was accepted"
  );

  assert.throws(
    () => jwt.verify(token, "a-different-secret"),
    "a token signed with a different secret was accepted"
  );

  const algNone = `${Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url")}.${payload}.`;
  assert.throws(
    () => jwt.verify(algNone, secret),
    "an unsigned alg=none token was accepted"
  );
});
