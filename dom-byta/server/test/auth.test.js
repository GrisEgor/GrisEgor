"use strict";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const h = require("./helpers");
const { verifyLoginData } = require("../src/lib/telegram");
const { safeNext } = require("../src/routes/auth");

let app;
before(async () => {
  app = await h.setup();
});
after(() => h.teardown(app));

const post = (url, payload, headers = {}) => app.inject({ method: "POST", url, payload, headers });

test("новый пользователь: без согласия — registration_required, код не тратится", async () => {
  const email = "new@test.ru";
  assert.equal((await post("/api/auth/email/request", { email })).statusCode, 200);
  const code = h.lastCode(email);

  const r1 = await post("/api/auth/email/verify", { email, code });
  assert.equal(r1.statusCode, 409);
  assert.equal(r1.json().error, "registration_required");

  const r2 = await post("/api/auth/email/verify", { email, code, consent: true, name: "Иван" });
  assert.equal(r2.statusCode, 200);
  assert.equal(r2.json().user.role, "tenant");
  assert.equal(r2.json().user.status, "active");
  assert.equal(r2.json().redirect, "/cabinet/");
  assert.ok(r2.cookies.find((c) => c.name === "dbsid" && c.httpOnly));

  // Код одноразовый.
  assert.equal((await post("/api/auth/email/verify", { email, code })).statusCode, 400);
});

test("повторный запрос кода раньше минуты — 429", async () => {
  const email = "rate@test.ru";
  assert.equal((await post("/api/auth/email/request", { email })).statusCode, 200);
  const r = await post("/api/auth/email/request", { email });
  assert.equal(r.statusCode, 429);
  assert.equal(r.json().error, "too_soon");
});

test("неверный код: после 5 ошибок код сгорает", async () => {
  const email = "brute@test.ru";
  await post("/api/auth/email/request", { email });
  const code = h.lastCode(email);
  const wrong = code === "000000" ? "111111" : "000000";
  for (let i = 0; i < 5; i++) {
    assert.equal((await post("/api/auth/email/verify", { email, code: wrong, consent: true })).json().error, "bad_code");
  }
  const r = await post("/api/auth/email/verify", { email, code, consent: true });
  assert.equal(r.json().error, "code_expired");
});

test("собственник регистрируется со статусом pending, админ — по ADMIN_EMAIL", async () => {
  const ll = await h.login(app, "owner@test.ru", { role: "landlord", consent: true });
  const me = (await app.inject({ url: "/api/auth/me", headers: ll })).json().user;
  assert.equal(me.role, "landlord");
  assert.equal(me.status, "pending");

  await post("/api/auth/email/request", { email: "admin@test.ru" });
  const r = await post("/api/auth/email/verify", { email: "admin@test.ru", code: h.lastCode("admin@test.ru"), consent: true });
  assert.equal(r.json().user.role, "admin");
  assert.equal(r.json().redirect, "/admin/");
});

test("пароль: задать после входа по коду и войти", async () => {
  const headers = await h.login(app, "pass@test.ru");
  assert.equal((await post("/api/auth/password", { password: "short" }, headers)).statusCode, 400);
  assert.equal((await post("/api/auth/password", { password: "длинный-пароль" }, headers)).statusCode, 200);

  const bad = await post("/api/auth/password/login", { email: "pass@test.ru", password: "нет" });
  assert.equal(bad.json().error, "invalid_credentials");
  const ok = await post("/api/auth/password/login", { email: "PASS@test.ru", password: "длинный-пароль" });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json().user.hasPassword, true);
});

test("выход удаляет сессию", async () => {
  const headers = await h.login(app, "logout@test.ru");
  assert.ok((await app.inject({ url: "/api/me", headers })).statusCode === 200);
  await post("/api/auth/logout", {}, headers);
  assert.equal((await app.inject({ url: "/api/me", headers })).statusCode, 401);
});

test("заблокированный пользователь не может войти, его сессии не работают", async () => {
  const headers = await h.login(app, "blocked@test.ru");
  await h.db.query("UPDATE users SET status = 'blocked' WHERE email = 'blocked@test.ru'");
  assert.equal((await app.inject({ url: "/api/me", headers })).statusCode, 401);
  await h.db.query("DELETE FROM email_codes");
  await post("/api/auth/email/request", { email: "blocked@test.ru" });
  const r = await post("/api/auth/email/verify", { email: "blocked@test.ru", code: h.lastCode("blocked@test.ru") });
  assert.equal(r.json().error, "blocked");
});

test("запросы с чужого Origin отклоняются", async () => {
  const r = await post("/api/auth/email/request", { email: "x@test.ru" }, { origin: "https://evil.example" });
  assert.equal(r.statusCode, 403);
  // Чужой Origin не помогает, даже если выдать себя за локальную сеть.
  const spoof = await post("/api/auth/email/request", { email: "x@test.ru" }, { origin: "http://192.168.1.5:8080", host: "localhost:8080" });
  assert.equal(spoof.statusCode, 403);
});

test("свой сайт по другому адресу (телефон в локальной сети) — пропускается", async () => {
  const r = await post("/api/auth/email/request", { email: "phone@test.ru" }, { origin: "http://192.168.1.5:8080", host: "192.168.1.5:8080" });
  assert.equal(r.statusCode, 200, r.body);
});

function signTelegram(data, token = "123:test-token") {
  const check = Object.keys(data).sort().map((k) => `${k}=${data[k]}`).join("\n");
  const secret = crypto.createHash("sha256").update(token).digest();
  return { ...data, hash: crypto.createHmac("sha256", secret).update(check).digest("hex") };
}

test("Telegram: проверка подписи", () => {
  const data = signTelegram({ id: "42", first_name: "Анна", auth_date: String(Math.floor(Date.now() / 1000)) });
  assert.equal(verifyLoginData(data), true);
  assert.equal(verifyLoginData({ ...data, id: "43" }), false);
  assert.equal(verifyLoginData(signTelegram({ id: "42", auth_date: "1000" })), false, "устаревшая подпись");
});

test("Telegram: регистрация, вход и привязка к существующему аккаунту", async () => {
  const now = String(Math.floor(Date.now() / 1000));
  const tg = signTelegram({ id: "777", first_name: "Пётр", username: "petr", auth_date: now });

  assert.equal((await post("/api/auth/telegram", { telegram: tg })).json().error, "registration_required");
  const r = await post("/api/auth/telegram", { telegram: tg, consent: true, role: "landlord" });
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().user.name, "Пётр");
  assert.equal(r.json().user.status, "pending");
  assert.deepEqual(r.json().user.identities, ["telegram"]);

  // Повторный вход — тот же пользователь.
  const again = await post("/api/auth/telegram", { telegram: tg });
  assert.equal(again.json().user.id, r.json().user.id);

  // Этот Telegram нельзя привязать к другому аккаунту.
  const other = await h.login(app, "other@test.ru");
  const taken = await post("/api/auth/telegram", { telegram: tg }, other);
  assert.equal(taken.json().error, "identity_taken");

  // А новый — привязывается к текущему аккаунту.
  const tg2 = signTelegram({ id: "778", first_name: "Other", auth_date: now });
  const linked = await post("/api/auth/telegram", { telegram: tg2 }, other);
  assert.deepEqual(linked.json().user.identities, ["telegram"]);
  assert.equal(linked.json().user.email, "other@test.ru");
});

test("смена почты — только через код на новый адрес", async () => {
  const now = String(Math.floor(Date.now() / 1000));
  const r = await post("/api/auth/telegram", { telegram: signTelegram({ id: "900", auth_date: now }), consent: true });
  const headers = { cookie: `dbsid=${r.cookies.find((c) => c.name === "dbsid").value}` };

  const taken = await post("/api/me/email/request", { email: "other@test.ru" }, headers);
  assert.equal(taken.json().error, "email_taken");

  await post("/api/me/email/request", { email: "tg@test.ru" }, headers);
  assert.equal((await post("/api/me/email/verify", { email: "tg@test.ru", code: "000000x" }, headers)).statusCode, 400);
  const ok = await post("/api/me/email/verify", { email: "tg@test.ru", code: h.lastCode("tg@test.ru") }, headers);
  assert.equal(ok.json().user.email, "tg@test.ru");
});

test("OAuth: старт ставит state, callback без state отклоняется", async () => {
  const r = await app.inject({ url: "/api/auth/yandex/start" });
  assert.equal(r.statusCode, 302);
  assert.equal(r.headers.location, "/login/?error=provider", "Яндекс не настроен");

  const cb = await app.inject({ url: "/api/auth/yandex/callback?code=1&state=x" });
  assert.equal(cb.headers.location, "/login/?error=state");
});

test("safeNext пропускает только локальные пути", () => {
  assert.equal(safeNext("/cabinet/#leads"), "/cabinet/#leads");
  assert.equal(safeNext("//evil.example"), "");
  assert.equal(safeNext("/\\evil.example"), "");
  assert.equal(safeNext("https://evil.example"), "");
});
