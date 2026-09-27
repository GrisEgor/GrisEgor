"use strict";

const config = require("../config");
const db = require("../db");
const { audit } = require("./audit");
const { HttpError } = require("./http");

function publicUser(u, identities = []) {
  return {
    id: Number(u.id),
    email: u.email,
    name: u.name,
    phone: u.phone,
    company: u.company,
    role: u.role,
    status: u.status,
    notify: u.notify,
    hasPassword: Boolean(u.password_hash),
    identities,
    createdAt: u.created_at,
  };
}

async function loadPublicUser(id) {
  const u = await db.one("SELECT * FROM users WHERE id = $1", [id]);
  if (!u) return null;
  const ids = await db.query("SELECT provider FROM identities WHERE user_id = $1 ORDER BY provider", [id]);
  return publicUser(u, ids.rows.map((r) => r.provider));
}

function isAdminEmail(email) {
  return Boolean(email && config.adminEmail && email.toLowerCase() === config.adminEmail);
}

// Новый пользователь. role — что выбрал человек при регистрации: собственник
// ждёт подтверждения админом, арендатор активен сразу.
async function createUser({ email, name, phone, role, consent }) {
  if (!consent) {
    throw new HttpError(409, "registration_required", "Нужно согласие на обработку персональных данных");
  }
  let status = "active";
  if (isAdminEmail(email)) role = "admin";
  else if (role === "landlord") status = "pending";
  else role = "tenant";
  const user = await db.one(
    `INSERT INTO users (email, name, phone, role, status, consent_at)
     VALUES ($1, $2, $3, $4, $5, now()) RETURNING *`,
    [email || null, name || "", phone || "", role, status]
  );
  await audit(user.id, "register", "user", user.id, { role, status });
  return user;
}

// Адрес из ADMIN_EMAIL становится админом, даже если аккаунт был создан раньше.
async function promoteAdminIfNeeded(user) {
  if (user.role !== "admin" && isAdminEmail(user.email)) {
    user = await db.one(
      "UPDATE users SET role = 'admin', status = 'active' WHERE id = $1 RETURNING *",
      [user.id]
    );
    await audit(user.id, "promote_admin", "user", user.id);
  }
  return user;
}

function assertCanLogin(user) {
  if (user.status === "blocked") throw new HttpError(403, "blocked", "Аккаунт заблокирован");
}

module.exports = { publicUser, loadPublicUser, createUser, promoteAdminIfNeeded, assertCanLogin, isAdminEmail };
