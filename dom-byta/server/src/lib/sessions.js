"use strict";

const config = require("../config");
const db = require("../db");
const { randomToken, sha256 } = require("./security");
const { unauthorized, forbidden } = require("./http");

const COOKIE = "dbsid";

function cookieOptions() {
  return {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: config.publicUrl.startsWith("https://"),
  };
}

async function createSession(req, reply, userId) {
  const token = randomToken();
  const days = config.sessionDays;
  await db.query(
    `INSERT INTO sessions (token_hash, user_id, expires_at, ip, user_agent)
     VALUES ($1, $2, now() + make_interval(days => $3), $4, $5)`,
    [sha256(token), userId, days, req.ip || "", String(req.headers["user-agent"] || "").slice(0, 300)]
  );
  await db.query("UPDATE users SET last_login_at = now() WHERE id = $1", [userId]);
  reply.setCookie(COOKIE, token, { ...cookieOptions(), maxAge: days * 86400 });
}

async function destroySession(req, reply) {
  const token = req.cookies[COOKIE];
  if (token) await db.query("DELETE FROM sessions WHERE token_hash = $1", [sha256(token)]);
  reply.clearCookie(COOKIE, cookieOptions());
}

// onRequest-хук: кладёт в req.user пользователя по cookie (или null).
async function loadUser(req) {
  req.user = null;
  const token = req.cookies[COOKIE];
  if (!token) return;
  req.user = await db.one(
    `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.expires_at > now() AND u.status <> 'blocked'`,
    [sha256(token)]
  );
}

function assertUser(req) {
  if (!req.user) throw unauthorized();
}

// preHandler: только для вошедших.
async function requireUser(req) {
  assertUser(req);
}

// requireRole("admin", "landlord") — preHandler для маршрутов.
function requireRole(...roles) {
  return async (req) => {
    assertUser(req);
    if (!roles.includes(req.user.role)) throw forbidden();
  };
}

module.exports = { COOKIE, createSession, destroySession, loadUser, assertUser, requireUser, requireRole };
