"use strict";

const crypto = require("node:crypto");
const config = require("../config");
const db = require("../db");
const { audit } = require("../lib/audit");
const { normEmail, sendCode, checkCode, consumeCode } = require("../lib/codes");
const { randomToken, hashPassword, verifyPassword } = require("../lib/security");
const { createSession, destroySession, requireUser } = require("../lib/sessions");
const { loadPublicUser, createUser, promoteAdminIfNeeded, assertCanLogin } = require("../lib/users");
const telegram = require("../lib/telegram");
const { HttpError, badRequest, str } = require("../lib/http");

const OAUTH_COOKIE = "dboauth";

function homeFor(user) {
  return user.role === "admin" ? "/admin/" : "/cabinet/";
}

// Куда вернуть после входа: только относительный путь на этом же сайте.
function safeNext(next) {
  return typeof next === "string" && /^\/(?![/\\])[\w\-./?=&#%]*$/.test(next) ? next : "";
}

// Данные регистрации: приходят вместе с первым входом, пока аккаунта нет.
function registration(src = {}) {
  return {
    role: src.role === "landlord" ? "landlord" : "tenant",
    name: str(src.name, 120),
    phone: str(src.phone, 40),
    consent: src.consent === true || src.consent === "1",
  };
}

function providers() {
  return {
    telegram: config.telegram.botToken ? config.telegram.botUsername : null,
    yandex: Boolean(config.yandex.clientId),
    vk: Boolean(config.vk.clientId),
  };
}

// Вход через внешний сервис. Если человек уже вошёл — привязываем сервис к его аккаунту.
async function externalLogin(req, { provider, uid, profile, email, name, reg }) {
  uid = String(uid);
  const identity = await db.one(
    "SELECT user_id FROM identities WHERE provider = $1 AND provider_uid = $2",
    [provider, uid]
  );

  if (req.user) {
    if (identity && Number(identity.user_id) !== Number(req.user.id)) {
      throw new HttpError(409, "identity_taken", "Этот аккаунт уже привязан к другому пользователю");
    }
    if (!identity) {
      await db.query(
        "INSERT INTO identities (user_id, provider, provider_uid, profile) VALUES ($1, $2, $3, $4)",
        [req.user.id, provider, uid, JSON.stringify(profile)]
      );
      await audit(req.user.id, "link_identity", "user", req.user.id, { provider });
    }
    return { user: req.user, linked: true };
  }

  let user = identity ? await db.one("SELECT * FROM users WHERE id = $1", [identity.user_id]) : null;
  if (!user && email) {
    // Яндекс и VK отдают подтверждённый адрес — объединяем с уже существующим аккаунтом.
    user = await db.one("SELECT * FROM users WHERE email = $1", [email]);
  }
  if (!user) {
    user = await createUser({ email, name: reg.name || name, phone: reg.phone, role: reg.role, consent: reg.consent });
  }
  assertCanLogin(user);
  if (!identity) {
    await db.query(
      `INSERT INTO identities (user_id, provider, provider_uid, profile) VALUES ($1, $2, $3, $4)
       ON CONFLICT (provider, provider_uid) DO NOTHING`,
      [user.id, provider, uid, JSON.stringify(profile)]
    );
  }
  user = await promoteAdminIfNeeded(user);
  return { user, linked: false };
}

function redirectUri(provider) {
  return `${config.publicUrl}/api/auth/${provider}/callback`;
}

async function postForm(url, fields) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) throw new Error(`${url}: ${res.status} ${json.error || ""}`);
  return json;
}

const oauth = {
  yandex: {
    enabled: () => Boolean(config.yandex.clientId),
    authorizeUrl(state) {
      const q = new URLSearchParams({
        response_type: "code",
        client_id: config.yandex.clientId,
        redirect_uri: redirectUri("yandex"),
        state: state.state,
      });
      return `https://oauth.yandex.ru/authorize?${q}`;
    },
    async fetchProfile(query) {
      const token = await postForm("https://oauth.yandex.ru/token", {
        grant_type: "authorization_code",
        code: query.code,
        client_id: config.yandex.clientId,
        client_secret: config.yandex.clientSecret,
      });
      const res = await fetch("https://login.yandex.ru/info?format=json", {
        headers: { Authorization: `OAuth ${token.access_token}` },
      });
      if (!res.ok) throw new Error(`Яндекс: info ${res.status}`);
      const info = await res.json();
      return {
        uid: info.id,
        email: info.default_email ? info.default_email.toLowerCase() : null,
        name: info.real_name || info.display_name || "",
        profile: { login: info.login || "", name: info.real_name || "" },
      };
    },
  },
  vk: {
    enabled: () => Boolean(config.vk.clientId),
    authorizeUrl(state) {
      const q = new URLSearchParams({
        response_type: "code",
        client_id: config.vk.clientId,
        redirect_uri: redirectUri("vk"),
        state: state.state,
        scope: "email",
        code_challenge: crypto.createHash("sha256").update(state.verifier).digest("base64url"),
        code_challenge_method: "S256",
      });
      return `https://id.vk.com/authorize?${q}`;
    },
    async fetchProfile(query, state) {
      const token = await postForm("https://id.vk.com/oauth2/auth", {
        grant_type: "authorization_code",
        code: query.code,
        code_verifier: state.verifier,
        client_id: config.vk.clientId,
        device_id: query.device_id || "",
        redirect_uri: redirectUri("vk"),
        state: state.state,
      });
      const info = await postForm("https://id.vk.com/oauth2/user_info", {
        client_id: config.vk.clientId,
        access_token: token.access_token,
      });
      const u = info.user || {};
      const name = [u.first_name, u.last_name].filter(Boolean).join(" ");
      return {
        uid: u.user_id || token.user_id,
        email: u.email ? String(u.email).toLowerCase() : null,
        name,
        profile: { name },
      };
    },
  },
};

async function routes(app) {
  const strictLimit = { rateLimit: { max: 10, timeWindow: "10 minutes" } };

  app.get("/api/auth/me", async (req) => ({
    user: req.user ? await loadPublicUser(req.user.id) : null,
    providers: providers(),
    devOutbox: config.devOutbox || undefined,
  }));

  app.post("/api/auth/logout", async (req, reply) => {
    await destroySession(req, reply);
    return { ok: true };
  });

  // ---------- Email: код ----------

  app.post("/api/auth/email/request", { config: strictLimit }, async (req) => {
    await sendCode(req.log, normEmail(req.body?.email));
    return { ok: true };
  });

  // Если аккаунта ещё нет и нет согласия на обработку ПДн, отвечаем 409
  // registration_required. Код при этом не тратится: клиент показывает форму
  // регистрации и повторяет запрос с теми же email и кодом.
  app.post(
    "/api/auth/email/verify",
    { config: { rateLimit: { max: 20, timeWindow: "10 minutes" } } },
    async (req, reply) => {
      const email = normEmail(req.body?.email);
      await checkCode(email, req.body?.code);

      let user = await db.one("SELECT * FROM users WHERE email = $1", [email]);
      if (!user) user = await createUser({ email, ...registration(req.body) });
      assertCanLogin(user);
      user = await promoteAdminIfNeeded(user);
      await consumeCode(email);
      await createSession(req, reply, user.id);
      return { user: await loadPublicUser(user.id), redirect: safeNext(req.body?.next) || homeFor(user) };
    }
  );

  // ---------- Email: пароль ----------

  app.post("/api/auth/password/login", { config: strictLimit }, async (req, reply) => {
    const email = normEmail(req.body?.email);
    const password = typeof req.body?.password === "string" ? req.body.password : "";
    const user = await db.one("SELECT * FROM users WHERE email = $1", [email]);
    if (!user || !(await verifyPassword(password, user.password_hash))) {
      throw badRequest("invalid_credentials", "Неверная почта или пароль");
    }
    assertCanLogin(user);
    await createSession(req, reply, user.id);
    return { user: await loadPublicUser(user.id), redirect: safeNext(req.body?.next) || homeFor(user) };
  });

  // Задать или сменить пароль. Вход по коду из письма уже подтверждает владение
  // почтой, поэтому это же и «восстановление пароля».
  app.post("/api/auth/password", { preHandler: requireUser }, async (req) => {
    const password = typeof req.body?.password === "string" ? req.body.password : "";
    if (password.length < 8 || password.length > 200) {
      throw badRequest("weak_password", "Пароль — не короче 8 символов");
    }
    if (!req.user.email) throw badRequest("no_email", "Сначала укажите почту в профиле");
    await db.query("UPDATE users SET password_hash = $1 WHERE id = $2", [await hashPassword(password), req.user.id]);
    await audit(req.user.id, "set_password", "user", req.user.id);
    return { ok: true };
  });

  // ---------- Telegram (виджет в режиме data-onauth) ----------

  app.post("/api/auth/telegram", { config: strictLimit }, async (req, reply) => {
    const data = req.body?.telegram || {};
    const fields = ["id", "first_name", "last_name", "username", "photo_url", "auth_date", "hash"];
    const tg = Object.fromEntries(fields.filter((k) => data[k] != null).map((k) => [k, String(data[k])]));
    if (!telegram.verifyLoginData(tg)) {
      throw badRequest("bad_telegram", "Не удалось проверить вход через Telegram");
    }
    const name = [tg.first_name, tg.last_name].filter(Boolean).join(" ");
    const { user, linked } = await externalLogin(req, {
      provider: "telegram",
      uid: tg.id,
      profile: { username: tg.username || "", name, photo: tg.photo_url || "" },
      email: null,
      name,
      reg: registration(req.body),
    });
    if (!linked) await createSession(req, reply, user.id);
    return { user: await loadPublicUser(user.id), redirect: safeNext(req.body?.next) || homeFor(user) };
  });

  // ---------- OAuth: Яндекс ID и VK ID ----------

  // Старт: /api/auth/yandex/start?role=landlord&consent=1&next=/cabinet/
  app.get("/api/auth/:provider/start", async (req, reply) => {
    const p = oauth[req.params.provider];
    if (!p || !p.enabled()) return reply.redirect("/login/?error=provider");
    const state = {
      state: randomToken(16),
      verifier: randomToken(48),
      ...registration(req.query),
      next: safeNext(req.query.next),
    };
    reply.setCookie(OAUTH_COOKIE, JSON.stringify(state), {
      path: "/api/auth/",
      httpOnly: true,
      sameSite: "lax",
      secure: config.publicUrl.startsWith("https://"),
      maxAge: 600,
    });
    return reply.redirect(p.authorizeUrl(state));
  });

  app.get("/api/auth/:provider/callback", async (req, reply) => {
    const provider = req.params.provider;
    const p = oauth[provider];
    let state = null;
    try {
      state = JSON.parse(req.cookies[OAUTH_COOKIE] || "null");
    } catch {
      state = null;
    }
    reply.clearCookie(OAUTH_COOKIE, { path: "/api/auth/" });
    const fail = (code) => reply.redirect(`/login/?error=${code}`);
    if (!p || !state || !req.query.state || req.query.state !== state.state) return fail("state");
    if (!req.query.code) return fail("denied");

    try {
      const info = await p.fetchProfile(req.query, state);
      const { user, linked } = await externalLogin(req, { provider, ...info, reg: state });
      if (!linked) await createSession(req, reply, user.id);
      return reply.redirect(linked ? "/cabinet/#profile" : state.next || homeFor(user));
    } catch (err) {
      if (err.code === "registration_required") return fail("consent");
      if (err.code === "identity_taken" || err.code === "blocked") return fail(err.code);
      req.log.error(err, `Ошибка входа через ${provider}`);
      return fail("provider");
    }
  });

  app.delete("/api/auth/identities/:provider", { preHandler: requireUser }, async (req) => {
    const { n } = await db.one("SELECT count(*)::int AS n FROM identities WHERE user_id = $1", [req.user.id]);
    // Не даём отвязать последний способ входа, если у аккаунта нет почты.
    if (!req.user.email && n <= 1) {
      throw badRequest("last_login_method", "Это единственный способ входа — сначала укажите почту в профиле");
    }
    await db.query("DELETE FROM identities WHERE user_id = $1 AND provider = $2", [req.user.id, req.params.provider]);
    await audit(req.user.id, "unlink_identity", "user", req.user.id, { provider: req.params.provider });
    return { ok: true };
  });
}

module.exports = routes;
module.exports.safeNext = safeNext;
