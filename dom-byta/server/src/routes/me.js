"use strict";

const db = require("../db");
const { audit } = require("../lib/audit");
const { normEmail, sendCode, checkCode, consumeCode } = require("../lib/codes");
const { requireUser } = require("../lib/sessions");
const { loadPublicUser, promoteAdminIfNeeded, landlordRequestMessage } = require("../lib/users");
const { notifyAdmins } = require("../lib/notify");
const { HttpError, badRequest, str } = require("../lib/http");

async function routes(app) {
  // Плагин инкапсулирован: хук действует только на маршруты этого файла.
  app.addHook("preHandler", requireUser);

  app.get("/api/me", async (req) => ({ user: await loadPublicUser(req.user.id) }));

  app.patch("/api/me", async (req) => {
    const b = req.body || {};
    const u = req.user;
    const notify = { ...u.notify };
    if (b.notify && typeof b.notify === "object") {
      for (const k of ["email", "telegram"]) {
        if (typeof b.notify[k] === "boolean") notify[k] = b.notify[k];
      }
    }
    await db.query(
      "UPDATE users SET name = $1, phone = $2, company = $3, notify = $4 WHERE id = $5",
      [
        b.name !== undefined ? str(b.name, 120) : u.name,
        b.phone !== undefined ? str(b.phone, 40) : u.phone,
        b.company !== undefined ? str(b.company, 200) : u.company,
        JSON.stringify(notify),
        u.id,
      ]
    );
    return { user: await loadPublicUser(u.id) };
  });

  // Смена или добавление почты — только через код на новый адрес, иначе можно
  // «занять» чужой адрес и получить его письма.
  app.post("/api/me/email/request", { config: { rateLimit: { max: 5, timeWindow: "10 minutes" } } }, async (req) => {
    const email = normEmail(req.body?.email);
    const taken = await db.one("SELECT id FROM users WHERE email = $1", [email]);
    if (taken && Number(taken.id) !== Number(req.user.id)) {
      throw new HttpError(409, "email_taken", "Этот адрес уже используется другим аккаунтом");
    }
    await sendCode(req.log, email, "подтверждения почты");
    return { ok: true };
  });

  app.post("/api/me/email/verify", async (req) => {
    const email = normEmail(req.body?.email);
    await checkCode(email, req.body?.code);
    const taken = await db.one("SELECT id FROM users WHERE email = $1", [email]);
    if (taken && Number(taken.id) !== Number(req.user.id)) {
      throw new HttpError(409, "email_taken", "Этот адрес уже используется другим аккаунтом");
    }
    const user = await db.one("UPDATE users SET email = $1 WHERE id = $2 RETURNING *", [email, req.user.id]);
    await consumeCode(email);
    await audit(req.user.id, "change_email", "user", req.user.id, { from: req.user.email, to: email });
    await promoteAdminIfNeeded(user);
    return { user: await loadPublicUser(req.user.id) };
  });

  // Арендатор просит статус собственника — дальше решает администратор.
  app.post("/api/me/landlord-request", async (req) => {
    if (req.user.role !== "tenant") throw badRequest("not_tenant", "У аккаунта уже есть роль собственника");
    await db.query("UPDATE users SET role = 'landlord', status = 'pending' WHERE id = $1", [req.user.id]);
    await audit(req.user.id, "landlord_request", "user", req.user.id);
    notifyAdmins(landlordRequestMessage(req.user));
    return { user: await loadPublicUser(req.user.id) };
  });

  app.get("/api/me/sessions", async (req) => {
    const { rows } = await db.query(
      `SELECT created_at, expires_at, ip, user_agent FROM sessions
       WHERE user_id = $1 AND expires_at > now() ORDER BY created_at DESC`,
      [req.user.id]
    );
    return { sessions: rows };
  });

  // «Выйти на всех устройствах».
  app.delete("/api/me/sessions", async (req, reply) => {
    await db.query("DELETE FROM sessions WHERE user_id = $1", [req.user.id]);
    reply.clearCookie("dbsid", { path: "/" });
    return { ok: true };
  });
}

module.exports = routes;
