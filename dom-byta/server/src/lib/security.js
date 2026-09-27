"use strict";

const crypto = require("node:crypto");
const { promisify } = require("node:util");

const scrypt = promisify(crypto.scrypt);

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString("base64url");
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function randomCode(digits = 6) {
  return String(crypto.randomInt(0, 10 ** digits)).padStart(digits, "0");
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

// Формат: scrypt$<salt>$<hash>, оба в base64url.
async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString("base64url")}$${hash.toString("base64url")}`;
}

async function verifyPassword(password, stored) {
  if (!stored) return false;
  const [scheme, salt, hash] = stored.split("$");
  if (scheme !== "scrypt" || !salt || !hash) return false;
  const actual = await scrypt(password, Buffer.from(salt, "base64url"), 64);
  return crypto.timingSafeEqual(actual, Buffer.from(hash, "base64url"));
}

module.exports = { randomToken, sha256, randomCode, safeEqual, hashPassword, verifyPassword };
