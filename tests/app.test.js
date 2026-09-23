/**
 * Smoke tests for the HTTP layer.
 *
 * The point of these is to catch the class of breakage that has historically
 * reached production here: a route that stops being reachable, middleware that
 * turns a normal rejection into a crash, or CORS headers going missing so the
 * frontend can no longer read responses. None of them require a database —
 * a 4xx from validation or auth is a pass, a 5xx is a failure.
 */
const test = require("node:test");
const assert = require("node:assert/strict");

const app = require("../app.js");

const ORIGIN = "https://iris-monde.vercel.app";
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

test("health endpoint responds", async () => {
  const res = await fetch(`${BASE}/`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, "success");
});

test("unknown routes return 404 rather than hanging or crashing", async () => {
  const res = await fetch(`${BASE}/api/v1/definitely-not-a-route`);
  assert.equal(res.status, 404);
});

const mountedRoutes = [
  ["GET", "/api/v1/users/workspace-users"],
  ["GET", "/api/v1/workspace/overview"],
  ["GET", "/api/v1/process/list"],
  ["GET", "/api/v1/iris-reporting/overview"],
  ["GET", "/api/v1/report-templates"],
  ["GET", "/api/v1/contracts"],
  ["GET", "/api/v1/activity-log/list"],
];

for (const [method, route] of mountedRoutes) {
  test(`${method} ${route} is mounted and rejects cleanly without auth`, async () => {
    const res = await fetch(`${BASE}${route}`, { method, headers: { Origin: ORIGIN } });

    assert.notEqual(res.status, 404, "route is not mounted");
    assert.ok(res.status >= 400 && res.status < 500, `expected an auth/validation rejection, got ${res.status}`);
    assert.equal(
      res.headers.get("access-control-allow-origin"),
      ORIGIN,
      "frontend would not be able to read this response"
    );
  });
}

test("contract signing links are reachable without logging in", async () => {
  const res = await fetch(`${BASE}/api/v1/contracts/public/some-token`, { headers: { Origin: ORIGIN } });
  // The signer has no account, so this must never demand authorization.
  assert.notEqual(res.status, 401);
  assert.notEqual(res.status, 404, "public signing route is not mounted");
});

test("a realistic signature payload is not rejected as too large", async () => {
  // Express defaults to a 100kb JSON body; a drawn signature can exceed it.
  const signature = `data:image/png;base64,${"A".repeat(120 * 1024)}`;
  const res = await fetch(`${BASE}/api/v1/contracts/public/some-token/sign`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: ORIGIN },
    body: JSON.stringify({ signerName: "Test Person", signature }),
  });
  assert.notEqual(res.status, 413, "signature payload hit the body size limit");
});
