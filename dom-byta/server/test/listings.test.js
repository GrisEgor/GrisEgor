"use strict";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const sharp = require("sharp");
const h = require("./helpers");
const notify = require("../src/lib/notify");
const config = require("../src/config");

let app, admin, owner, stranger;
before(async () => {
  app = await h.setup();
  admin = await h.login(app, "admin@test.ru");
  owner = await h.landlord(app, "owner@test.ru");
  stranger = await h.landlord(app, "stranger@test.ru");
});
after(() => h.teardown(app));

const req = (method, url, headers, payload) => app.inject({ method, url, headers, payload });
const publicCodes = async () => (await req("GET", "/api/listings")).json().listings.map((l) => l.id);

function multipart(files) {
  const boundary = "----dombyta" + Date.now();
  const chunks = [];
  for (const [name, buf] of files) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\n` +
          "Content-Type: application/octet-stream\r\n\r\n"
      ),
      buf,
      Buffer.from("\r\n")
    );
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(chunks), type: `multipart/form-data; boundary=${boundary}` };
}

async function upload(headers, files) {
  const { body, type } = multipart(files);
  return app.inject({ method: "POST", url: "/api/uploads", headers: { ...headers, "content-type": type }, payload: body });
}

test("публичный API отдаёт импортированные объявления в формате listings.json", async () => {
  const res = await req("GET", "/api/listings");
  assert.equal(res.statusCode, 200);
  const data = res.json();
  assert.equal(data.building.floors, 8);
  const original = JSON.parse(fs.readFileSync(path.join(config.siteDir, "data", "listings.json"), "utf8"));
  assert.equal(data.listings.length, original.listings.length);
  const a = data.listings.find((l) => l.id === "f8-07");
  const b = original.listings.find((l) => l.id === "f8-07");
  for (const k of ["floor", "title", "areaM2", "pricePerM2", "type", "status", "owner", "floorPlan", "photos"]) {
    assert.deepEqual(a[k], b[k], k);
  }
  assert.equal(a.demo, false);
  assert.equal(data.listings.find((l) => l.id === "f1-01").demo, true);
});

test("загрузка фото: webp, превью, EXIF убран; мусор отклоняется", async () => {
  const png = await sharp({ create: { width: 3000, height: 1500, channels: 3, background: "#c33" } })
    .withMetadata({ exif: { IFD0: { Copyright: "secret" } } })
    .jpeg()
    .toBuffer();
  const res = await upload(owner, [["a.jpg", png]]);
  assert.equal(res.statusCode, 200, res.body);
  const [file] = res.json().files;
  assert.match(file.url, /^\/uploads\/\d{4}\/\d{2}\/[\w-]+\.webp$/);
  assert.equal(file.width, 1920);
  const saved = await sharp(path.join(config.uploadsDir, file.url.replace("/uploads/", ""))).metadata();
  assert.equal(saved.format, "webp");
  assert.equal(saved.exif, undefined);
  const thumb = await app.inject({ url: file.thumb });
  assert.equal(thumb.statusCode, 200);

  const bad = await upload(owner, [["x.jpg", Buffer.from("not an image")]]);
  assert.equal(bad.json().error, "bad_image");

  const tenant = await h.login(app, "tenant@test.ru");
  assert.equal((await upload(tenant, [["a.jpg", png]])).statusCode, 403);
});

test("жизненный цикл: черновик → модерация → отклонено → снова → опубликовано", async () => {
  const photo = (await upload(owner, [["p.png", await sharp({ create: { width: 10, height: 10, channels: 3, background: "#fff" } }).png().toBuffer()]])).json().files[0].url;

  const created = await req("POST", "/api/my/listings", owner, {
    title: "Офис с видом",
    floor: 3,
    areaM2: 41.25,
    pricePerM2: 800,
    type: "Офис",
    photos: [photo, "assets/img/placeholder.png"],
    floorPlan: "assets/img/floorplans/plan-a-rect.svg",
  });
  assert.equal(created.statusCode, 200, created.body);
  const l = created.json().listing;
  assert.equal(l.code, "f3-02", "f3-01 занят импортом");
  assert.equal(l.moderation, "draft");
  assert.equal(l.areaM2, 41.3);
  assert.equal(l.demo, false);
  assert.ok(!(await publicCodes()).includes(l.code));

  // Без описания на модерацию нельзя.
  const incomplete = await req("POST", `/api/my/listings/${l.id}/submit`, owner);
  assert.equal(incomplete.json().error, "incomplete");
  await req("PATCH", `/api/my/listings/${l.id}`, owner, { description: "Светлый офис" });

  // Чужой собственник не видит и не трогает.
  assert.equal((await req("GET", `/api/my/listings/${l.id}`, stranger)).statusCode, 403);
  assert.equal((await req("PATCH", `/api/my/listings/${l.id}`, stranger, { title: "x" })).statusCode, 403);

  h.outbox.length = 0;
  assert.equal((await req("POST", `/api/my/listings/${l.id}/submit`, owner)).json().listing.moderation, "pending");
  await notify.flush();
  assert.ok(h.outbox.some((m) => m.to === "admin@test.ru" && /модерации/.test(m.subject)));

  const queue = (await req("GET", "/api/admin/listings?moderation=queue", admin)).json().listings;
  assert.deepEqual(queue.map((x) => x.id), [l.id]);

  assert.equal((await req("POST", `/api/admin/listings/${l.id}/reject`, admin, {})).json().error, "comment_required");
  const rejected = await req("POST", `/api/admin/listings/${l.id}/reject`, admin, { comment: "Добавьте фото окна" });
  assert.equal(rejected.json().listing.moderation, "rejected");
  await notify.flush();
  assert.ok(h.outbox.some((m) => m.to === "owner@test.ru" && /Добавьте фото окна/.test(m.text)));

  await req("POST", `/api/my/listings/${l.id}/submit`, owner);
  const approved = await req("POST", `/api/admin/listings/${l.id}/approve`, admin);
  assert.equal(approved.json().listing.moderation, "published");
  assert.ok((await publicCodes()).includes(l.code));

  // Удалить опубликованное нельзя — только в архив.
  assert.equal((await req("DELETE", `/api/my/listings/${l.id}`, owner)).json().error, "was_published");
});

test("правки опубликованного — через модерацию, занятость — сразу", async () => {
  const mine = (await req("GET", "/api/my/listings", owner)).json().listings;
  const l = mine.find((x) => x.moderation === "published");

  const r = await req("PATCH", `/api/my/listings/${l.id}`, owner, { title: "Новое название", pricePerM2: 900, availability: "reserved" });
  const after = r.json().listing;
  assert.equal(after.title, "Офис с видом", "живая версия не изменилась");
  assert.equal(after.availability, "reserved", "занятость применилась сразу");
  assert.deepEqual(after.pendingChanges, { title: "Новое название", pricePerM2: 900 });

  let pub = (await req("GET", "/api/listings")).json().listings.find((x) => x.id === l.code);
  assert.equal(pub.title, "Офис с видом");
  assert.equal(pub.status, "reserved");

  await req("POST", `/api/admin/listings/${l.id}/approve`, admin);
  pub = (await req("GET", "/api/listings")).json().listings.find((x) => x.id === l.code);
  assert.equal(pub.title, "Новое название");
  assert.equal(pub.pricePerM2, 900);
  const fresh = (await req("GET", `/api/my/listings/${l.id}`, owner)).json().listing;
  assert.equal(fresh.pendingChanges, null);

  // Отклонённые правки сбрасываются, объявление остаётся опубликованным.
  await req("PATCH", `/api/my/listings/${l.id}`, owner, { title: "Плохое" });
  const rej = (await req("POST", `/api/admin/listings/${l.id}/reject`, admin, { comment: "Нет" })).json().listing;
  assert.equal(rej.moderation, "published");
  assert.equal(rej.pendingChanges, null);
  assert.equal(rej.title, "Новое название");
});

test("архив и удаление черновика", async () => {
  const d = (await req("POST", "/api/my/listings", owner, { title: "Склад", floor: 1, areaM2: 20 })).json().listing;
  const arch = (await req("POST", `/api/my/listings/${d.id}/archive`, owner)).json().listing;
  assert.equal(arch.moderation, "archived");
  assert.ok(!(await req("GET", "/api/my/listings", owner)).json().listings.some((x) => x.id === d.id));
  assert.ok((await req("GET", "/api/my/listings?archived=1", owner)).json().listings.some((x) => x.id === d.id));
  assert.equal((await req("POST", `/api/my/listings/${d.id}/restore`, owner)).json().listing.moderation, "draft");
  assert.equal((await req("DELETE", `/api/my/listings/${d.id}`, owner)).statusCode, 200);
});

test("собственник без подтверждения не может отправить на модерацию", async () => {
  const pending = await h.login(app, "pending@test.ru", { role: "landlord", consent: true });
  const d = (await req("POST", "/api/my/listings", pending, { title: "Кабинет", floor: 2, areaM2: 15, description: "…" })).json().listing;
  const r = await req("POST", `/api/my/listings/${d.id}/submit`, pending);
  assert.equal(r.statusCode, 403);
});

test("валидация полей и чужие файлы", async () => {
  const bad = [
    { title: "", floor: 1, areaM2: 1 },
    { title: "x", floor: 9, areaM2: 1 },
    { title: "x", floor: 1, areaM2: -5 },
    { title: "x", floor: 1, areaM2: 5, photos: ["https://evil.example/a.jpg"] },
    { title: "x", floor: 1, areaM2: 5, photos: ["/uploads/2026/01/nope.webp"] },
    { title: "x", floor: 1, areaM2: 5, availability: "sold" },
  ];
  for (const payload of bad) {
    assert.equal((await req("POST", "/api/my/listings", owner, payload)).statusCode, 400, JSON.stringify(payload));
  }
  const tenant = await h.login(app, "tenant2@test.ru");
  assert.equal((await req("GET", "/api/my/listings", tenant)).statusCode, 403);
  assert.equal((await req("GET", "/api/admin/listings", owner)).statusCode, 403);
});

test("админ создаёт и публикует сразу, назначает собственника", async () => {
  const r = await req("POST", "/api/admin/listings", admin, { title: "Зал", floor: 5, areaM2: 100, publish: true, demo: true });
  assert.equal(r.statusCode, 200, r.body);
  const l = r.json().listing;
  assert.equal(l.moderation, "published");
  assert.equal(l.demo, true);
  const ownerId = (await h.db.one("SELECT id FROM users WHERE email = 'owner@test.ru'")).id;
  const tenantId = (await h.db.one("SELECT id FROM users WHERE email = 'tenant@test.ru'")).id;
  assert.equal((await req("PATCH", `/api/admin/listings/${l.id}`, admin, { ownerId: tenantId })).json().error, "bad_owner");
  const assigned = (await req("PATCH", `/api/admin/listings/${l.id}`, admin, { ownerId })).json().listing;
  assert.equal(assigned.ownerEmail, "owner@test.ru");
  assert.ok((await req("GET", "/api/my/listings", owner)).json().listings.some((x) => x.id === l.id));
});
