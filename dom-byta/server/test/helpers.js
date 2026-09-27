"use strict";

// Тесты идут против настоящего Postgres из docker compose (порт 55432),
// в отдельной базе dombyta_test, которая пересоздаётся в начале каждого файла.
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const { Client } = require("pg");

const base = process.env.TEST_DATABASE_URL || "postgres://dombyta:dombyta@localhost:55432/dombyta";
const testUrl = base.replace(/\/[^/]*$/, "/dombyta_test");

process.env.DATABASE_URL = testUrl;
process.env.ADMIN_EMAIL = "admin@test.ru";
process.env.TELEGRAM_BOT_TOKEN = "123:test-token";
process.env.TELEGRAM_BOT_USERNAME = "dombyta_test_bot";
process.env.PUBLIC_URL = "http://localhost:8080";
process.env.UPLOADS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "dombyta-uploads-"));
delete process.env.SMTP_HOST;

const db = require("../src/db");
const { migrate } = require("../src/migrate");
const { buildApp } = require("../src/app");
const { outbox } = require("../src/lib/mail");

const silent = { info() {}, warn() {}, error() {} };

async function setup() {
  const admin = new Client({ connectionString: base });
  await admin.connect();
  const exists = await admin.query("SELECT 1 FROM pg_database WHERE datname = 'dombyta_test'");
  if (!exists.rowCount) await admin.query("CREATE DATABASE dombyta_test");
  await admin.end();

  await db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await migrate(silent);
  return buildApp({ logger: false, noRateLimit: true });
}

async function teardown(app) {
  await app.close();
  await db.pool.end();
}

function lastCode(email) {
  for (let i = outbox.length - 1; i >= 0; i--) {
    if (outbox[i].to === email) return outbox[i].text.match(/\b(\d{6})\b/)[1];
  }
  throw new Error(`Нет письма для ${email}`);
}

// Вход по коду из письма; для нового пользователя сразу регистрируем.
// Возвращает заголовки с cookie сессии для следующих запросов.
async function login(app, email, reg = { role: "tenant", consent: true }) {
  await db.query("DELETE FROM email_codes WHERE email = $1", [email]);
  const r1 = await app.inject({ method: "POST", url: "/api/auth/email/request", payload: { email } });
  if (r1.statusCode !== 200) throw new Error(r1.body);
  const r2 = await app.inject({
    method: "POST",
    url: "/api/auth/email/verify",
    payload: { email, code: lastCode(email), ...reg },
  });
  if (r2.statusCode !== 200) throw new Error(r2.body);
  const cookie = r2.cookies.find((c) => c.name === "dbsid");
  return { cookie: `dbsid=${cookie.value}` };
}

// Собственник, уже подтверждённый админом.
async function landlord(app, email) {
  const headers = await login(app, email, { role: "landlord", consent: true, name: "Собственник" });
  await db.query("UPDATE users SET status = 'active' WHERE email = $1", [email]);
  return headers;
}

module.exports = { setup, teardown, login, landlord, lastCode, outbox, db };
