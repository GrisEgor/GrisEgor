"use strict";

// Сквозной сценарий через настоящий HTTP-сервер: так же, как это делают браузер,
// кабинеты и сайт. Собственник регистрируется → админ подтверждает → собственник
// создаёт объявление с фото и отправляет на модерацию → админ публикует → сайт
// видит объявление, посетитель оставляет заявку → собственник её получает.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const sharp = require("sharp");
const h = require("./helpers");
const notify = require("../src/lib/notify");

let app, base;
before(async () => {
  app = await h.setup();
  await app.listen({ port: 0, host: "127.0.0.1" });
  base = `http://127.0.0.1:${app.server.address().port}`;
});
after(() => h.teardown(app));

// Мини-браузер: хранит cookie и шлёт Origin, как настоящий.
function browser() {
  let cookie = "";
  return async function call(method, path, body, extra = {}) {
    const headers = { origin: "http://localhost:8080", ...(cookie ? { cookie } : {}), ...extra.headers };
    let payload;
    if (body instanceof FormData) payload = body;
    else if (body !== undefined) {
      headers["content-type"] = "application/json";
      payload = JSON.stringify(body);
    }
    const res = await fetch(base + path, { method, headers, body: payload, redirect: "manual" });
    const set = res.headers.getSetCookie().find((c) => c.startsWith("dbsid="));
    if (set) cookie = set.split(";")[0];
    const type = res.headers.get("content-type") || "";
    const data = type.includes("json") ? await res.json() : await res.text();
    return { status: res.status, data, headers: res.headers };
  };
}

async function signIn(call, email, reg) {
  assert.equal((await call("POST", "/api/auth/email/request", { email })).status, 200);
  const res = await call("POST", "/api/auth/email/verify", { email, code: h.lastCode(email), ...reg });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  return res.data;
}

test("страницы сайта, входа и кабинетов открываются", async () => {
  const call = browser();
  for (const [path, marker] of [
    ["/", "Дом быта"],
    ["/login/", "login.js"],
    ["/admin/", "admin.js"],
    ["/cabinet/", "cabinet.js"],
    ["/privacy/", "Политика обработки персональных данных"],
    ["/panel/core.js", "export async function api"],
  ]) {
    const r = await call("GET", path);
    assert.equal(r.status, 200, path);
    assert.ok(r.data.includes(marker), path);
  }
  assert.equal((await call("GET", "/login")).status, 302);
  assert.equal((await call("GET", "/nope")).status, 404);
});

test("полный путь объявления и заявки", async () => {
  const admin = browser();
  const owner = browser();
  const visitor = browser();

  const adminLogin = await signIn(admin, "admin@test.ru", { consent: true, name: "Админ" });
  assert.equal(adminLogin.redirect, "/admin/");

  // 1. Собственник регистрируется — ждёт подтверждения, админу приходит письмо.
  h.outbox.length = 0;
  const reg = await signIn(owner, "owner@test.ru", { consent: true, role: "landlord", name: "Иван", phone: "+79001112233" });
  assert.equal(reg.user.status, "pending");
  await notify.flush();
  assert.ok(h.outbox.some((m) => m.to === "admin@test.ru" && /собственник/i.test(m.subject)));

  // 2. Черновик можно, модерацию — нельзя.
  const png = await sharp({ create: { width: 1200, height: 900, channels: 3, background: "#8a6" } }).jpeg().toBuffer();
  const fd = new FormData();
  fd.append("file", new Blob([png], { type: "image/jpeg" }), "room.jpg");
  const up = await owner("POST", "/api/uploads", fd);
  assert.equal(up.status, 200, JSON.stringify(up.data));
  const photo = up.data.files[0].url;
  assert.equal((await visitor("GET", photo)).status, 200, "фото отдаётся");

  const draft = await owner("POST", "/api/my/listings", {
    title: "Кабинет 18 м² у окна",
    floor: 6,
    areaM2: 18,
    pricePerM2: 700,
    type: "Кабинет",
    description: "Тихий кабинет, окно во двор.",
    photos: [photo],
    floorPlan: "assets/img/floorplans/plan-g-nook.svg",
  });
  assert.equal(draft.status, 200, JSON.stringify(draft.data));
  const id = draft.data.listing.id;
  const code = draft.data.listing.code;
  assert.equal((await owner("POST", `/api/my/listings/${id}/submit`)).status, 403);

  // 3. Админ подтверждает собственника.
  const pending = (await admin("GET", "/api/admin/users?status=pending")).data.users;
  const ownerId = pending.find((u) => u.email === "owner@test.ru").id;
  assert.equal((await admin("PATCH", `/api/admin/users/${ownerId}`, { status: "active" })).status, 200);

  // 4. Отправка на модерацию → публикация.
  assert.equal((await owner("POST", `/api/my/listings/${id}/submit`)).data.listing.moderation, "pending");
  const dash = (await admin("GET", "/api/admin/dashboard")).data;
  assert.equal(dash.counts.moderation, 1);
  assert.equal((await admin("POST", `/api/admin/listings/${id}/approve`)).data.listing.moderation, "published");

  // 5. Сайт видит объявление.
  const pub = (await visitor("GET", "/api/listings")).data.listings.find((l) => l.id === code);
  assert.ok(pub, "объявление на сайте");
  assert.deepEqual(pub.photos, [photo]);
  assert.equal(pub.owner, "Иван");
  assert.equal(pub.demo, false);

  // 6. Посетитель смотрит карточку и оставляет заявку.
  await visitor("POST", "/api/stats", { v: "e2e-visitor-1", events: [{ t: "view" }, { t: "impression", l: code }, { t: "open", l: code }, { t: "cta", l: code }] });
  h.outbox.length = 0;
  const lead = await visitor("POST", "/api/leads", { kind: "rent", listing: code, name: "Ольга", phone: "8 (912) 000-11-22", message: "Можно посмотреть в субботу?", consent: true });
  assert.equal(lead.status, 200, JSON.stringify(lead.data));
  await notify.flush();
  const mail = h.outbox.find((m) => m.to === "owner@test.ru");
  assert.ok(mail, "собственник получил письмо о заявке");
  assert.match(mail.text, /Ольга/);
  assert.match(mail.text, /\/cabinet\/#leads/);

  // 7. Собственник видит заявку и статистику, двигает статус.
  const leads = (await owner("GET", "/api/my/leads")).data.leads;
  assert.equal(leads.length, 1);
  assert.equal((await owner("PATCH", `/api/my/leads/${leads[0].id}`, { status: "viewing" })).data.lead.status, "viewing");
  const stats = (await owner("GET", "/api/my/stats")).data;
  const row = stats.listings.find((l) => l.code === code);
  assert.deepEqual([row.impression, row.open, row.cta, row.lead, row.conversion], [1, 1, 1, 1, 100]);

  // 8. Занятость — сразу, название — через модерацию.
  await owner("PATCH", `/api/my/listings/${id}`, { availability: "occupied", title: "Кабинет 18 м²" });
  const after1 = (await visitor("GET", "/api/listings")).data.listings.find((l) => l.id === code);
  assert.equal(after1.status, "occupied");
  assert.equal(after1.title, "Кабинет 18 м² у окна");

  // 9. Журнал помнит всё это.
  const actions = (await admin("GET", "/api/admin/audit")).data.entries.map((e) => e.action);
  for (const a of ["register", "user_update", "create", "submit", "approve", "lead_status", "availability", "edit"]) {
    assert.ok(actions.includes(a), a);
  }

  // 10. Выход.
  await owner("POST", "/api/auth/logout");
  assert.equal((await owner("GET", "/api/my/listings")).status, 401);
});
