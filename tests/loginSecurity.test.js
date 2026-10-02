/**
 * Sign-in hardening.
 *
 * Two problems this covers. The per-IP rate limiter in app.js uses an
 * in-memory store, so on serverless each instance counts separately and an
 * attacker spreading requests gets many times the stated limit — the lockout
 * here lives in the database and holds regardless. And the old sign-in told
 * callers whether an email existed before checking the password, which on a
 * compliance product leaks the client list to anyone who can type an address.
 *
 * Run with: npm run test:isolation
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

process.env.JWT_SECRET = process.env.JWT_SECRET || "login-security-secret";

const { User } = require("../src/models");
const authService = require("../src/services/auth.service");
const userService = require("../src/modules/users/service");

let mongod;

const EMAIL = "victim@acme.test";
const PASSWORD = "CorrectPass123";

const freshUser = async (email = EMAIL) => {
  await User.deleteMany({ email });
  return User.create({
    name: "Target", email, username: `u-${Date.now()}`,
    password: PASSWORD, userType: "admin", isEmailVerified: true,
  });
};

/** Attempts a sign-in and reports what came back, without throwing. */
const attempt = async (email, password) => {
  try {
    await authService.loginUserWithEmailAndPassword(email, password);
    return { ok: true };
  } catch (err) {
    return { ok: false, status: err.statusCode, message: err.message };
  }
};

test.before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
});

test.after(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

// ─── Account enumeration ─────────────────────────────────────────────────────
test("a wrong password and an unknown address are indistinguishable", async () => {
  await freshUser();

  const wrongPassword = await attempt(EMAIL, "WrongPass123");
  const noSuchAccount = await attempt("nobody@nowhere.test", "WrongPass123");

  assert.equal(wrongPassword.ok, false);
  assert.equal(noSuchAccount.ok, false);
  assert.equal(
    wrongPassword.message, noSuchAccount.message,
    "the two must read identically, or the response reveals which addresses have accounts"
  );
  assert.ok(
    !/not found|no such|incorrect password/i.test(wrongPassword.message),
    "the message must not say which half was wrong"
  );
});

// ─── Lockout ─────────────────────────────────────────────────────────────────
test("five wrong passwords lock the account", async () => {
  await freshUser();

  for (let i = 1; i <= 4; i += 1) {
    const result = await attempt(EMAIL, "WrongPass123");
    assert.equal(result.status, 400, `attempt ${i} should be an ordinary rejection`);
  }

  const fifth = await attempt(EMAIL, "WrongPass123");
  assert.equal(fifth.status, 429, "the fifth should lock the account");
  assert.match(fifth.message, /locked/i);
});

test("the correct password is refused while the account is locked", async () => {
  // The point of a lockout: knowing the password later does not help an
  // attacker who has just been locked out of guessing it.
  const locked = await attempt(EMAIL, PASSWORD);
  assert.equal(locked.ok, false, "a locked account must refuse even the right password");
  assert.equal(locked.status, 429);
  assert.match(locked.message, /try again in/i, "it should say how long to wait");
});

test("the lock expires on its own", async () => {
  const user = await User.findOne({ email: EMAIL });
  user.lockedUntil = new Date(Date.now() - 1000); // as if the 15 minutes had passed
  await user.save();

  const result = await attempt(EMAIL, PASSWORD);
  assert.equal(result.ok, true, "once the lock expires the right password must work again");
});

test("a successful sign-in clears the count, so typos never accumulate", async () => {
  await freshUser();

  await attempt(EMAIL, "WrongPass123");
  await attempt(EMAIL, "WrongPass123");
  assert.equal((await User.findOne({ email: EMAIL })).failedLoginAttempts, 2);

  await attempt(EMAIL, PASSWORD);
  assert.equal(
    (await User.findOne({ email: EMAIL })).failedLoginAttempts, 0,
    "occasional typos spread over weeks must not add up to a lockout"
  );
});

test("failed attempts are recorded, not just counted", async () => {
  await freshUser();
  await attempt(EMAIL, "WrongPass123");

  const user = await User.findOne({ email: EMAIL });
  assert.ok(user.lastFailedLoginAt, "there should be a record of when it happened");
});

// ─── Recovery ────────────────────────────────────────────────────────────────
test("resetting the password unlocks the account", async () => {
  const user = await freshUser();
  for (let i = 0; i < 5; i += 1) await attempt(EMAIL, "WrongPass123");
  assert.equal((await attempt(EMAIL, PASSWORD)).status, 429, "should be locked first");

  // The lockout message promises this works, so it has to.
  const token = "reset-token-for-test";
  user.resetToken = token;
  user.resetTokenExpiry = new Date(Date.now() + 60 * 60 * 1000);
  await user.save();

  await userService.resetPasswordByToken({ token, password: "BrandNewPass123" });

  const after = await attempt(EMAIL, "BrandNewPass123");
  assert.equal(after.ok, true, "a password reset must clear the lock, as the message says it does");
});
