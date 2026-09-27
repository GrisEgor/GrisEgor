"use strict";

const crypto = require("node:crypto");
const config = require("../config");

// Проверка данных виджета «Войти через Telegram»:
// https://core.telegram.org/widgets/login#checking-authorization
function verifyLoginData(data, botToken = config.telegram.botToken, maxAgeSec = 86400) {
  if (!botToken || !data || typeof data.hash !== "string") return false;
  const checkString = Object.keys(data)
    .filter((k) => k !== "hash" && data[k] !== undefined && data[k] !== null)
    .sort()
    .map((k) => `${k}=${data[k]}`)
    .join("\n");
  const secret = crypto.createHash("sha256").update(botToken).digest();
  const expected = crypto.createHmac("sha256", secret).update(checkString).digest("hex");
  const given = Buffer.from(data.hash);
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, Buffer.from(expected))) {
    return false;
  }
  const age = Date.now() / 1000 - Number(data.auth_date);
  return Number.isFinite(age) && age < maxAgeSec;
}

// Писать можно только тем, кто разрешил боту сообщения (виджет с request-access="write").
async function sendMessage(chatId, text) {
  if (!config.telegram.botToken) return false;
  const res = await fetch(`https://api.telegram.org/bot${config.telegram.botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
  });
  return res.ok;
}

module.exports = { verifyLoginData, sendMessage };
