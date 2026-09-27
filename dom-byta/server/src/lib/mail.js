"use strict";

const nodemailer = require("nodemailer");
const config = require("../config");

let transport = null;
// Без SMTP письма копятся здесь (последние 50) — их читают тесты и видно в логе.
const outbox = [];

function getTransport() {
  if (!transport && config.smtp.host) {
    transport = nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.secure,
      auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
    });
  }
  return transport;
}

async function sendMail(log, { to, subject, text }) {
  const t = getTransport();
  if (!t) {
    outbox.push({ to, subject, text, at: new Date() });
    if (outbox.length > 50) outbox.shift();
    log.info({ to, subject }, `Письмо (SMTP не настроен):\n${text}`);
    return;
  }
  await t.sendMail({ from: config.smtp.from, to, subject, text });
}

module.exports = { sendMail, outbox };
