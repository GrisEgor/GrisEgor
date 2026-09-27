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
  panelDir: path.resolve(env.PANEL_DIR || path.join(root, "panel")),
  uploadsDir: path.resolve(env.UPLOADS_DIR || path.join(root, "uploads")),
  // Этот email при первом входе получает роль администратора.
  adminEmail: (env.ADMIN_EMAIL || "").trim().toLowerCase(),
  isProduction: env.NODE_ENV === "production",

  sessionDays: Number(env.SESSION_DAYS || 30),
  // Только для локальной проверки: /api/dev/outbox показывает письма, которые не ушли
  // (SMTP не настроен). На сервере не включать — иначе любой прочитает коды входа.
  devOutbox: env.DEV_OUTBOX === "1" && env.NODE_ENV !== "production",

  // Почта. Без SMTP_HOST письма не отправляются, а пишутся в лог (удобно локально).
  smtp: {
    host: env.SMTP_HOST || "",
    port: Number(env.SMTP_PORT || 465),
    secure: (env.SMTP_SECURE || "true") !== "false",
    user: env.SMTP_USER || "",
    pass: env.SMTP_PASS || "",
    from: env.MAIL_FROM || "Дом быта <noreply@localhost>",
  },

  telegram: {
    botToken: env.TELEGRAM_BOT_TOKEN || "",
    // Имя бота без @ — нужно виджету входа.
    botUsername: env.TELEGRAM_BOT_USERNAME || "",
  },
  yandex: {
    clientId: env.YANDEX_CLIENT_ID || "",
    clientSecret: env.YANDEX_CLIENT_SECRET || "",
  },
  vk: {
    // VK ID: вход по OAuth 2.1 с PKCE, секрет приложения не нужен.
    clientId: env.VK_CLIENT_ID || "",
  },
};
