"use strict";

/*
 * FoxLock password storage.
 *
 * Loaded as a classic script by the background page, lock.html and
 * options.html. The password is never stored in plain text: the stored record
 * holds a random salt and a PBKDF2-SHA-256 hash, kept in browser.storage.local.
 *
 * Versions 1.0.0 to 1.0.2 stored the password as plain text under the key
 * "password". That value is converted to a hash the first time it is needed,
 * then removed.
 */
const FoxAuth = (() => {
  const DEFAULT_PASSWORD = "admin123";
  const RECORD_KEY = "passwordRecord";
  const LEGACY_KEY = "password";
  const ITERATIONS = 310000; // stored in the record, so it can be raised later
  const MIN_LENGTH = 8;
  const MAX_LENGTH = 128;

  function toHex(bytes) {
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  }

  function fromHex(hex) {
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i += 1) {
      out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }
    return out;
  }

  function sameBytes(a, b) {
    if (a.length !== b.length) {
      return false;
    }
    let diff = 0;
    for (let i = 0; i < a.length; i += 1) {
      diff |= a[i] ^ b[i];
    }
    return diff === 0;
  }

  async function derive(password, salt, iterations) {
    const material = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(password),
      "PBKDF2",
      false,
      ["deriveBits"]
    );
    const bits = await crypto.subtle.deriveBits(
      { name: "PBKDF2", hash: "SHA-256", salt, iterations },
      material,
      256
    );
    return new Uint8Array(bits);
  }

  async function makeRecord(password) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const hash = await derive(password, salt, ITERATIONS);
    return { salt: toHex(salt), hash: toHex(hash), iterations: ITERATIONS };
  }

  function isValidRecord(record) {
    return (
      record !== null &&
      typeof record === "object" &&
      typeof record.salt === "string" &&
      typeof record.hash === "string" &&
      Number.isInteger(record.iterations) &&
      record.iterations > 0
    );
  }

  // Returns the stored record, creating it from the old plain text password
  // (or the default password) when none exists yet.
  async function readRecord() {
    const stored = await browser.storage.local.get([RECORD_KEY, LEGACY_KEY]);
    if (isValidRecord(stored[RECORD_KEY])) {
      return stored[RECORD_KEY];
    }
    const legacy = stored[LEGACY_KEY];
    const initial =
      typeof legacy === "string" && legacy.length > 0 ? legacy : DEFAULT_PASSWORD;
    const created = await makeRecord(initial);
    await browser.storage.local.set({ [RECORD_KEY]: created });
    await browser.storage.local.remove(LEGACY_KEY);
    return created;
  }

  async function ensure() {
    await readRecord();
  }

  async function verify(password) {
    if (typeof password !== "string") {
      return false;
    }
    const record = await readRecord();
    const hash = await derive(password, fromHex(record.salt), record.iterations);
    return sameBytes(hash, fromHex(record.hash));
  }

  function validateNewPassword(password) {
    if (typeof password !== "string" || password.length < MIN_LENGTH) {
      return "too-short";
    }
    if (password.length > MAX_LENGTH) {
      return "too-long";
    }
    if (password === DEFAULT_PASSWORD) {
      return "is-default";
    }
    return null;
  }

  // Returns { ok: true } or { ok: false, reason } where reason is one of
  // "wrong-current", "too-short", "too-long", "is-default", "same-as-current".
  async function changePassword(current, next) {
    if (!(await verify(current))) {
      return { ok: false, reason: "wrong-current" };
    }
    const problem = validateNewPassword(next);
    if (problem) {
      return { ok: false, reason: problem };
    }
    if (next === current) {
      return { ok: false, reason: "same-as-current" };
    }
    await browser.storage.local.set({ [RECORD_KEY]: await makeRecord(next) });
    return { ok: true };
  }

  function usesDefaultPassword() {
    return verify(DEFAULT_PASSWORD);
  }

  return {
    MIN_LENGTH,
    MAX_LENGTH,
    ensure,
    verify,
    changePassword,
    usesDefaultPassword
  };
})();
