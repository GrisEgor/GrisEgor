"use strict";

const config = require("../config");
const db = require("../db");
const { sendMail } = require("./mail");
const { randomCode, sha256, safeEqual } = require("./security");
const { HttpError, badRequest, str } = require("./http");

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CODE_TTL_MIN = 10;
const CODE_MAX_ATTEMPTS = 5;
const CODE_RESEND_SEC = 60;

function normEmail(value) {
  const email = str(value, 200).toLowerCase();
  if (!EMAIL_RE.test(email)) throw badRequest("bad_email", "Проверьте адрес почты");
  return email;
}

// Одноразовый код на почту: для входа и для подтверждения нового адреса в профиле.
async function sendCode(log, email, purpose = "входа") {
  const prev = await db.one(
    "SELECT extract(epoch FROM now() - created_at)::float AS age FROM email_codes WHERE email = $1",
    [email]
  );
  if (prev && prev.age < CODE_RESEND_SEC) {
    throw new HttpError(429, "too_soon", "Код уже отправлен, новый можно запросить через минуту");
  }
  const code = randomCode();
  await db.query(
    `INSERT INTO email_codes (email, code_hash, attempts, expires_at, created_at)
     VALUES ($1, $2, 0, now() + make_interval(mins => $3), now())
     ON CONFLICT (email) DO UPDATE SET code_hash = EXCLUDED.code_hash, attempts = 0,
       expires_at = EXCLUDED.expires_at, created_at = now()`,
    [email, sha256(code), CODE_TTL_MIN]
  );
  await sendMail(log, {
    to: email,
    subject: `Код для ${purpose}: ${code}`,
    text:
      `Ваш код для ${purpose} на сайте Дома быта: ${code}\n\n` +
      `Код действует ${CODE_TTL_MIN} минут. Если вы его не запрашивали, просто проигнорируйте письмо.\n\n` +
      config.publicUrl,
  });
}

// Проверяет код, но не удаляет его: это делает consumeCode после успешного действия.
async function checkCode(email, rawCode) {
  const code = str(rawCode, 10).replace(/\s/g, "");
  const row = await db.one("SELECT * FROM email_codes WHERE email = $1", [email]);
  if (!row || new Date(row.expires_at) < new Date() || row.attempts >= CODE_MAX_ATTEMPTS) {
    throw badRequest("code_expired", "Код устарел, запросите новый");
  }
  if (!safeEqual(sha256(code), row.code_hash)) {
    await db.query("UPDATE email_codes SET attempts = attempts + 1 WHERE email = $1", [email]);
    throw badRequest("bad_code", "Неверный код");
  }
}

function consumeCode(email) {
  return db.query("DELETE FROM email_codes WHERE email = $1", [email]);
}

module.exports = { normEmail, sendCode, checkCode, consumeCode };
