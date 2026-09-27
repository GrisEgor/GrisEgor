"use strict";

const db = require("../db");
const { badRequest, str } = require("./http");

const AVAILABILITY = ["available", "reserved", "occupied"];
const MAX_PHOTOS = 12;

// Поля, правки которых у опубликованного объявления идут через модерацию.
const MODERATED = ["title", "type", "floor", "areaM2", "pricePerM2", "description", "floorPlan", "photos", "ownerLabel"];

// Картинка — либо загруженный файл (/uploads/…), либо файл сайта из assets/img/.
function validImage(value) {
  return (
    typeof value === "string" &&
    (/^\/uploads\/[\w\-/]+\.webp$/.test(value) || /^assets\/img\/[\w\-/]+\.(svg|png|jpe?g|webp)$/.test(value))
  );
}

// Разбор полей из запроса. Возвращает только переданные поля (для частичного обновления).
function parseFields(body = {}, { admin = false } = {}) {
  const f = {};
  if (body.title !== undefined) {
    f.title = str(body.title, 200);
    if (!f.title) throw badRequest("bad_title", "Укажите название");
  }
  if (body.type !== undefined) f.type = str(body.type, 60);
  if (body.description !== undefined) f.description = str(body.description, 3000);
  if (body.floor !== undefined) {
    f.floor = Number(body.floor);
    if (!Number.isInteger(f.floor) || f.floor < 1 || f.floor > 8) throw badRequest("bad_floor", "Этаж — от 1 до 8");
  }
  if (body.areaM2 !== undefined) {
    f.areaM2 = Math.round(Number(body.areaM2) * 10) / 10;
    if (!(f.areaM2 > 0 && f.areaM2 < 100000)) throw badRequest("bad_area", "Проверьте площадь");
  }
  if (body.pricePerM2 !== undefined) {
    f.pricePerM2 = Math.round(Number(body.pricePerM2));
    if (!(f.pricePerM2 >= 0 && f.pricePerM2 < 1000000)) throw badRequest("bad_price", "Проверьте цену");
  }
  if (body.availability !== undefined) {
    if (!AVAILABILITY.includes(body.availability)) throw badRequest("bad_availability", "Неизвестный статус занятости");
    f.availability = body.availability;
  }
  if (body.floorPlan !== undefined) {
    f.floorPlan = body.floorPlan ? String(body.floorPlan) : "";
    if (f.floorPlan && !validImage(f.floorPlan)) throw badRequest("bad_floor_plan", "Неверная схема помещения");
  }
  if (body.photos !== undefined) {
    if (!Array.isArray(body.photos) || body.photos.length > MAX_PHOTOS || !body.photos.every(validImage)) {
      throw badRequest("bad_photos", `Фото — до ${MAX_PHOTOS} штук, загруженные через кабинет`);
    }
    f.photos = body.photos;
  }
  if (body.ownerLabel !== undefined) f.ownerLabel = str(body.ownerLabel, 120);
  if (admin) {
    if (body.demo !== undefined) f.demo = Boolean(body.demo);
    if (body.sort !== undefined) f.sort = Math.round(Number(body.sort)) || 0;
    if (body.ownerId !== undefined) f.ownerId = body.ownerId ? Number(body.ownerId) : null;
  }
  return f;
}

const COLUMNS = {
  title: "title",
  type: "type",
  floor: "floor",
  areaM2: "area_m2",
  pricePerM2: "price_per_m2",
  description: "description",
  availability: "availability",
  floorPlan: "floor_plan",
  photos: "photos",
  ownerLabel: "owner_label",
  demo: "demo",
  sort: "sort",
  ownerId: "owner_id",
};

function columns(fields) {
  const cols = [];
  const values = [];
  for (const [k, v] of Object.entries(fields)) {
    cols.push(COLUMNS[k]);
    values.push(k === "photos" ? JSON.stringify(v) : v);
  }
  return { cols, values };
}

// { title: "…", photos: [...] } → "title = $2, photos = $3", [ "…", "[...]" ]
function setClause(fields, startIndex = 1) {
  const { cols, values } = columns(fields);
  return { sql: cols.map((c, i) => `${c} = $${startIndex + i}`).join(", "), values };
}

// INSERT с фиксированными первыми колонками: insert({ code, owner_id }, fields).
async function insert(client, fixed, fields) {
  const extra = columns(fields);
  const cols = [...Object.keys(fixed), ...extra.cols];
  const values = [...Object.values(fixed), ...extra.values];
  const params = values.map((_, i) => `$${i + 1}`);
  const res = await client.query(
    `INSERT INTO listings (${cols.join(", ")}) VALUES (${params.join(", ")}) RETURNING id`,
    values
  );
  return res.rows[0].id;
}

// Для публичного сайта — тот же формат, что был в data/listings.json.
function toPublic(l) {
  return {
    id: l.code,
    floor: l.floor,
    title: l.title,
    areaM2: Number(l.area_m2),
    pricePerM2: l.price_per_m2,
    type: l.type,
    description: l.description,
    status: l.availability,
    owner: l.owner_label,
    demo: l.demo,
    floorPlan: l.floor_plan || undefined,
    photos: l.photos.length ? l.photos : undefined,
  };
}

// Для кабинета и админки: всё, включая модерацию.
function toPrivate(l) {
  return {
    id: Number(l.id),
    code: l.code,
    ownerId: l.owner_id ? Number(l.owner_id) : null,
    ownerLabel: l.owner_label,
    ownerName: l.owner_name,
    ownerEmail: l.owner_email,
    floor: l.floor,
    title: l.title,
    type: l.type,
    areaM2: Number(l.area_m2),
    pricePerM2: l.price_per_m2,
    description: l.description,
    availability: l.availability,
    floorPlan: l.floor_plan,
    photos: l.photos,
    demo: l.demo,
    moderation: l.moderation,
    moderationComment: l.moderation_comment,
    pendingChanges: l.pending_changes,
    sort: l.sort,
    createdAt: l.created_at,
    updatedAt: l.updated_at,
    submittedAt: l.submitted_at,
    publishedAt: l.published_at,
  };
}

const SELECT_PRIVATE = `
  SELECT l.*, u.name AS owner_name, u.email AS owner_email
  FROM listings l LEFT JOIN users u ON u.id = l.owner_id`;

async function getPrivate(id) {
  return db.one(`${SELECT_PRIVATE} WHERE l.id = $1`, [id]);
}

// Код для публичной ссылки: f<этаж>-<номер>, первый свободный на этаже.
// Вызывается внутри транзакции: блокировка не даёт двум запросам взять один код.
async function nextCode(floor, client) {
  await client.query("SELECT pg_advisory_xact_lock(hashtext('listing_code'))");
  const { rows } = await client.query("SELECT code FROM listings WHERE code LIKE $1", [`f${floor}-%`]);
  const used = new Set(rows.map((r) => r.code));
  for (let n = 1; ; n++) {
    const code = `f${floor}-${String(n).padStart(2, "0")}`;
    if (!used.has(code)) return code;
  }
}

function missingForSubmit(l) {
  const missing = [];
  if (!l.title) missing.push("название");
  if (!(Number(l.area_m2) > 0)) missing.push("площадь");
  if (!l.description) missing.push("описание");
  return missing;
}

module.exports = {
  MODERATED,
  parseFields,
  setClause,
  insert,
  toPublic,
  toPrivate,
  SELECT_PRIVATE,
  getPrivate,
  nextCode,
  missingForSubmit,
};
