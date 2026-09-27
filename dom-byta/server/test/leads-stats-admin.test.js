"use strict";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const h = require("./helpers");
const notify = require("../src/lib/notify");

let app, admin, owner, other, listing;
before(async () => {
  app = await h.setup();
  admin = await h.login(app, "admin@test.ru");
  owner = await h.landlord(app, "owner@test.ru");
  other = await h.landlord(app, "other@test.ru");
  const ownerId = (await h.db.one("SELECT id FROM users WHERE email = 'owner@test.ru'")).id;
  await h.db.query("UPDATE listings SET owner_id = $1 WHERE code = 'f8-01'", [ownerId]);
  listing = await h.db.one("SELECT * FROM listings WHERE code = 'f8-01'");
});
after(() => h.teardown(app));

const req = (method, url, headers, payload) => app.inject({ method, url, headers, payload });
const lead = (payload) => req("POST", "/api/leads", {}, { consent: true, name: "Анна", phone: "+7 900 111-22-33", ...payload });

test("заявка на помещение: в БД, собственнику и админу", async () => {
  h.outbox.length = 0;
  const r = await lead({ kind: "rent", listing: "f8-01", message: "Нужен офис на год" });
  assert.equal(r.statusCode, 200, r.body);
  await notify.flush();
  const toOwner = h.outbox.find((m) => m.to === "owner@test.ru");
  assert.ok(toOwner, "собственник получил письмо");
  assert.match(toOwner.text, /Анна/);
  assert.match(toOwner.text, /f8-01/);
  assert.ok(h.outbox.some((m) => m.to === "admin@test.ru"));
  assert.ok(!h.outbox.some((m) => m.to === "other@test.ru"));

  const mine = (await req("GET", "/api/my/leads", owner)).json().leads;
  assert.equal(mine.length, 1);
  assert.equal(mine[0].listingCode, "f8-01");
  assert.equal(mine[0].status, "new");
  assert.equal((await req("GET", "/api/my/leads", other)).json().leads.length, 0);
});

test("проверки формы: согласие, телефон, ловушка для ботов", async () => {
  assert.equal((await lead({ consent: false })).json().error, "consent_required");
  assert.equal((await lead({ phone: "123" })).json().error, "required");
  const before = (await h.db.one("SELECT count(*)::int AS n FROM leads")).n;
  assert.equal((await lead({ website: "http://spam" })).statusCode, 200);
  assert.equal((await h.db.one("SELECT count(*)::int AS n FROM leads")).n, before, "бот-заявка не сохранена");
});

test("заявка собственника и общая заявка — только админу", async () => {
  await lead({ kind: "owner", floor: "3", area: "40", description: "Офис у лифта" });
  await lead({ kind: "rent", floor: "5", message: "Что есть?" });
  const all = (await req("GET", "/api/admin/leads", admin)).json().leads;
  const ownerLead = all.find((l) => l.kind === "owner");
  assert.match(ownerLead.message, /Этаж: 3/);
  assert.match(ownerLead.message, /40 м²/);
  const contact = all.find((l) => l.kind === "contact");
  assert.equal(contact.landlordId, null);
  assert.match(contact.message, /этаж: 5/);
});

test("смена статуса пишет историю; чужую заявку не видно", async () => {
  const [l] = (await req("GET", "/api/my/leads", owner)).json().leads;
  const r = await req("PATCH", `/api/my/leads/${l.id}`, owner, { status: "viewing", note: "Просмотр в пятницу", comment: "Созвонились" });
  assert.equal(r.json().lead.status, "viewing");
  assert.equal(r.json().lead.note, "Просмотр в пятницу");
  const detail = (await req("GET", `/api/my/leads/${l.id}`, owner)).json();
  assert.deepEqual(detail.events.map((e) => e.to), ["new", "viewing"]);
  assert.equal(detail.events[1].comment, "Созвонились");

  assert.equal((await req("PATCH", `/api/my/leads/${l.id}`, other, { status: "won" })).statusCode, 404);
  assert.equal((await req("PATCH", `/api/my/leads/${l.id}`, owner, { status: "sold" })).statusCode, 400);
  // Собственник не может переадресовать заявку.
  await req("PATCH", `/api/my/leads/${l.id}`, owner, { landlordId: 1 });
  assert.equal((await req("GET", `/api/my/leads/${l.id}`, owner)).statusCode, 200);
});

test("админ передаёт заявку собственнику", async () => {
  const contact = (await req("GET", "/api/admin/leads?kind=contact", admin)).json().leads[0];
  const otherId = (await h.db.one("SELECT id FROM users WHERE email = 'other@test.ru'")).id;
  h.outbox.length = 0;
  const r = await req("PATCH", `/api/admin/leads/${contact.id}`, admin, { landlordId: otherId, status: "in_progress" });
  assert.equal(r.json().lead.landlordId, Number(otherId));
  await notify.flush();
  assert.ok(h.outbox.some((m) => m.to === "other@test.ru" && /передали/.test(m.subject)));
  assert.equal((await req("GET", "/api/my/leads", other)).json().leads.length, 1);
});

test("статистика: события с сайта, посетители, конверсия", async () => {
  const ev = (v, events, ua = "Mozilla/5.0") => req("POST", "/api/stats", { "user-agent": ua }, { v, events });
  await ev("visitor-aaaa", [{ t: "view" }, { t: "impression", l: "f8-01" }, { t: "impression", l: "f8-02" }, { t: "open", l: "f8-01" }]);
  await ev("visitor-aaaa", [{ t: "view" }, { t: "open", l: "f8-01" }, { t: "cta", l: "f8-01" }]);
  await ev("visitor-bbbb", [{ t: "view" }, { t: "contact" }, { t: "open", l: "nope" }, { t: "hack", l: "f8-01" }]);
  await ev("visitor-cccc", [{ t: "view" }], "Mozilla/5.0 (compatible; YandexBot/3.0)");

  const s = (await req("GET", "/api/admin/stats", admin)).json();
  assert.equal(s.days.length, 30);
  assert.equal(s.totals.view, 3, "бот не посчитан");
  assert.equal(s.totals.visitor, 2);
  assert.equal(s.totals.impression, 2);
  assert.equal(s.totals.open, 2);
  assert.equal(s.totals.cta, 1);
  assert.equal(s.totals.contact, 1);
  assert.equal(s.totals.lead, 3, "все заявки с сайта");
  const f801 = s.listings.find((l) => l.code === "f8-01");
  assert.equal(f801.open, 2);
  assert.equal(f801.lead, 1);
  assert.equal(f801.conversion, 50);

  const mine = (await req("GET", "/api/my/stats", owner)).json();
  assert.deepEqual(mine.listings.map((l) => l.code), ["f8-01"]);
  assert.equal(mine.totals.view, 0, "собственник не видит просмотры всего сайта");
  assert.equal(mine.totals.open, 2);
  assert.equal(mine.totals.lead, 1);

  const range = (await req("GET", "/api/admin/stats?from=2026-01-01&to=2026-01-07", admin)).json();
  assert.equal(range.days.length, 7);
  assert.equal((await req("GET", "/api/admin/stats?from=2020-01-01&to=2026-01-07", admin)).statusCode, 400);
  assert.equal((await req("GET", "/api/admin/stats", owner)).statusCode, 403);
});

test("админ: подтверждение собственника, блокировка, журнал", async () => {
  await h.login(app, "newowner@test.ru", { role: "landlord", consent: true });
  const pending = (await req("GET", "/api/admin/users?status=pending", admin)).json().users;
  assert.deepEqual(pending.map((u) => u.email), ["newowner@test.ru"]);

  h.outbox.length = 0;
  const approved = await req("PATCH", `/api/admin/users/${pending[0].id}`, admin, { status: "active" });
  assert.equal(approved.json().user.status, "active");
  await notify.flush();
  assert.ok(h.outbox.some((m) => m.to === "newowner@test.ru" && /подтверждён/.test(m.subject)));

  const adminId = (await h.db.one("SELECT id FROM users WHERE email = 'admin@test.ru'")).id;
  assert.equal((await req("PATCH", `/api/admin/users/${adminId}`, admin, { status: "blocked" })).json().error, "self");

  const log = (await req("GET", "/api/admin/audit?entity=user", admin)).json().entries;
  assert.ok(log.some((e) => e.action === "user_update" && e.meta.status[1] === "active"));
});

test("админ: дашборд и настройки Метрики", async () => {
  const d = (await req("GET", "/api/admin/dashboard", admin)).json();
  assert.equal(d.counts.newLeads, 1, "две из трёх заявок уже в работе");
  assert.equal(d.week.views, 3);
  assert.equal(d.recentLeads.length, 3);

  assert.equal((await req("PUT", "/api/admin/settings", admin, { metrikaId: "abc" })).statusCode, 400);
  await req("PUT", "/api/admin/settings", admin, { metrikaId: "98765432" });
  assert.equal((await req("GET", "/api/settings")).json().metrikaId, "98765432");
  assert.equal((await req("PUT", "/api/admin/settings", owner, { metrikaId: "1" })).statusCode, 403);
});
