"use strict";

const config = require("../config");
const db = require("../db");
const { sendMail } = require("./mail");
const telegram = require("./telegram");

let log = { info() {}, warn() {}, error() {} };
const pending = new Set();

function setLogger(logger) {
  log = logger;
}

// Уведомление одному пользователю по каналам, которые он не отключил в профиле.
// Ошибки доставки только логируются: из-за упавшего SMTP заявка не должна теряться.
async function deliver(user, { subject, text, link }) {
  const body = link ? `${text}\n\n${config.publicUrl}${link}` : text;
  const flags = user.notify || {};
  const jobs = [];
  if (user.email && flags.email !== false) {
    jobs.push(sendMail(log, { to: user.email, subject, text: body }));
  }
  if (flags.telegram !== false && config.telegram.botToken) {
    const tg = await db.one(
      "SELECT provider_uid FROM identities WHERE user_id = $1 AND provider = 'telegram'",
      [user.id]
    );
    if (tg) jobs.push(telegram.sendMessage(tg.provider_uid, `${subject}\n\n${body}`));
  }
  const results = await Promise.allSettled(jobs);
  for (const r of results) {
    if (r.status === "rejected") log.error(r.reason, `Не доставлено уведомление пользователю ${user.id}`);
  }
}

async function toUsers(where, params, message) {
  const { rows } = await db.query(`SELECT * FROM users WHERE status <> 'blocked' AND ${where}`, params);
  await Promise.all(rows.map((u) => deliver(u, message)));
}

// Отправка в фоне: запрос пользователя не ждёт почту и Telegram.
function background(promise) {
  const p = promise.catch((err) => log.error(err, "Ошибка отправки уведомления")).finally(() => pending.delete(p));
  pending.add(p);
}

function notifyUser(userId, message) {
  if (userId) background(toUsers("id = $1", [userId], message));
}

function notifyAdmins(message) {
  background(toUsers("role = 'admin'", [], message));
}

// Для тестов: дождаться всех отправок.
async function flush() {
  while (pending.size) await Promise.all([...pending]);
}

module.exports = { setLogger, notifyUser, notifyAdmins, flush };
