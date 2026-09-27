"use strict";

const path = require("node:path");

const env = process.env;
const root = path.resolve(__dirname, "..", "..");

module.exports = {
  port: Number(env.PORT || 3000),
  host: env.HOST || "0.0.0.0",
  // Публичный адрес сайта: из него строятся ссылки в письмах и redirect_uri для OAuth.
  publicUrl: (env.PUBLIC_URL || "http://localhost:8080").replace(/\/$/, ""),
  databaseUrl: env.DATABASE_URL || "postgres://dombyta:dombyta@localhost:5432/dombyta",
  siteDir: path.resolve(env.SITE_DIR || path.join(root, "site")),
  uploadsDir: path.resolve(env.UPLOADS_DIR || path.join(root, "uploads")),
  // Этот email при первом входе получает роль администратора.
  adminEmail: (env.ADMIN_EMAIL || "").trim().toLowerCase(),
  isProduction: env.NODE_ENV === "production",
};
