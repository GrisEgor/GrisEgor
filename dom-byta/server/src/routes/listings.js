"use strict";

const db = require("../db");
const { audit } = require("../lib/audit");
const { requireRole } = require("../lib/sessions");
const { notifyAdmins, notifyUser } = require("../lib/notify");
const L = require("../lib/listings");
const { badRequest, forbidden, notFound, str } = require("../lib/http");

const DEFAULT_BUILDING = {
  name: "Дом быта",
  addressShort: "ул. Васенко, 96",
  addressFull: "г. Челябинск, ул. Васенко, 96",
  floors: 8,
};

// Все загруженные фото из списка должны реально существовать.
async function checkUploads(fields) {
  const urls = [...(fields.photos || []), fields.floorPlan || ""].filter((u) => u.startsWith("/uploads/"));
  if (!urls.length) return;
  const { rows } = await db.query("SELECT path FROM uploads WHERE path = ANY($1)", [urls]);
  if (rows.length !== new Set(urls).size) throw badRequest("bad_photos", "Фото не найдено — загрузите его заново");
}

async function update(id, fields, extraSql = "") {
  const { sql, values } = L.setClause(fields, 2);
  const set = [sql, "updated_at = now()", extraSql].filter(Boolean).join(", ");
  await db.query(`UPDATE listings SET ${set} WHERE id = $1`, [id, ...values]);
}

function label(l) {
  return `«${l.title}» (${l.code}, этаж ${l.floor})`;
}

async function routes(app) {
  // ---------- Публичный сайт ----------

  app.get("/api/listings", async (req, reply) => {
    const { rows } = await db.query(
      "SELECT * FROM listings WHERE moderation = 'published' ORDER BY floor, sort, id"
    );
    const building = await db.one("SELECT value FROM settings WHERE key = 'building'");
    reply.header("Cache-Control", "no-cache");
    return { building: building ? building.value : DEFAULT_BUILDING, listings: rows.map(L.toPublic) };
  });

  // ---------- Кабинет собственника ----------

  const landlordOnly = { preHandler: requireRole("landlord", "admin") };

  async function ownListing(req) {
    const l = await L.getPrivate(req.params.id);
    if (!l) throw notFound("Объявление не найдено");
    if (Number(l.owner_id) !== Number(req.user.id)) throw forbidden("Это не ваше объявление");
    return l;
  }

  app.get("/api/my/listings", landlordOnly, async (req) => {
    const { rows } = await db.query(
      `${L.SELECT_PRIVATE} WHERE l.owner_id = $1 AND ($2 OR l.moderation <> 'archived')
       ORDER BY l.floor, l.sort, l.id`,
      [req.user.id, req.query.archived === "1"]
    );
    return { listings: rows.map(L.toPrivate) };
  });

  app.get("/api/my/listings/:id", landlordOnly, async (req) => ({ listing: L.toPrivate(await ownListing(req)) }));

  app.post("/api/my/listings", landlordOnly, async (req) => {
    const fields = L.parseFields(req.body);
    if (!fields.title || !fields.floor || !fields.areaM2) {
      throw badRequest("required", "Заполните название, этаж и площадь");
    }
    await checkUploads(fields);
    const ownerLabel = fields.ownerLabel || req.user.company || req.user.name || "Собственник";
    const id = await db.transaction(async (client) =>
      L.insert(client, { code: await L.nextCode(fields.floor, client), owner_id: req.user.id, demo: false }, {
        ...fields,
        ownerLabel,
      })
    );
    await audit(req.user.id, "create", "listing", id);
    return { listing: L.toPrivate(await L.getPrivate(id)) };
  });

  // Занятость меняется сразу. Остальное у опубликованного объявления копится в
  // pending_changes и ждёт модерации, живая версия на сайте не меняется.
  app.patch("/api/my/listings/:id", landlordOnly, async (req) => {
    const l = await ownListing(req);
    const fields = L.parseFields(req.body);
    await checkUploads(fields);

    const direct = {};
    const moderated = {};
    for (const [k, v] of Object.entries(fields)) {
      (L.MODERATED.includes(k) && l.moderation === "published" ? moderated : direct)[k] = v;
    }
    if (Object.keys(direct).length) await update(l.id, direct);
    if (Object.keys(moderated).length) {
      const merged = { ...(l.pending_changes || {}), ...moderated };
      await db.query(
        `UPDATE listings SET pending_changes = $2, submitted_at = now(), moderation_comment = '',
           updated_at = now() WHERE id = $1`,
        [l.id, JSON.stringify(merged)]
      );
      if (!l.pending_changes) {
        notifyAdmins({
          subject: "Правки объявления ждут модерации",
          text: `Собственник изменил объявление ${label(l)}.`,
          link: "/admin/#moderation",
        });
      }
    }
    if (direct.availability && direct.availability !== l.availability) {
      await audit(req.user.id, "availability", "listing", l.id, { from: l.availability, to: direct.availability });
    }
    if (Object.keys(moderated).length || Object.keys(direct).some((k) => k !== "availability")) {
      await audit(req.user.id, "edit", "listing", l.id, { fields: Object.keys(fields) });
    }
    return { listing: L.toPrivate(await L.getPrivate(l.id)) };
  });

  app.post("/api/my/listings/:id/submit", landlordOnly, async (req) => {
    const l = await ownListing(req);
    if (req.user.status !== "active") {
      throw forbidden("Отправлять на модерацию можно после подтверждения аккаунта администратором");
    }
    if (!["draft", "rejected"].includes(l.moderation)) {
      throw badRequest("bad_state", "Отправить на модерацию можно черновик или отклонённое объявление");
    }
    const missing = L.missingForSubmit(l);
    if (missing.length) throw badRequest("incomplete", `Заполните: ${missing.join(", ")}`);
    await db.query(
      `UPDATE listings SET moderation = 'pending', moderation_comment = '', submitted_at = now(),
         updated_at = now() WHERE id = $1`,
      [l.id]
    );
    await audit(req.user.id, "submit", "listing", l.id);
    notifyAdmins({
      subject: "Новое объявление на модерации",
      text: `Собственник отправил на модерацию объявление ${label(l)}.`,
      link: "/admin/#moderation",
    });
    return { listing: L.toPrivate(await L.getPrivate(l.id)) };
  });

  app.post("/api/my/listings/:id/discard-changes", landlordOnly, async (req) => {
    const l = await ownListing(req);
    await db.query("UPDATE listings SET pending_changes = NULL, updated_at = now() WHERE id = $1", [l.id]);
    await audit(req.user.id, "discard_changes", "listing", l.id);
    return { listing: L.toPrivate(await L.getPrivate(l.id)) };
  });

  app.post("/api/my/listings/:id/archive", landlordOnly, async (req) => {
    const l = await ownListing(req);
    await db.query(
      "UPDATE listings SET moderation = 'archived', pending_changes = NULL, updated_at = now() WHERE id = $1",
      [l.id]
    );
    await audit(req.user.id, "archive", "listing", l.id, { from: l.moderation });
    return { listing: L.toPrivate(await L.getPrivate(l.id)) };
  });

  app.post("/api/my/listings/:id/restore", landlordOnly, async (req) => {
    const l = await ownListing(req);
    if (l.moderation !== "archived") throw badRequest("bad_state", "Объявление не в архиве");
    await db.query("UPDATE listings SET moderation = 'draft', updated_at = now() WHERE id = $1", [l.id]);
    await audit(req.user.id, "restore", "listing", l.id);
    return { listing: L.toPrivate(await L.getPrivate(l.id)) };
  });

  // Удалить можно только то, что никогда не было на сайте; остальное — в архив.
  app.delete("/api/my/listings/:id", landlordOnly, async (req) => {
    const l = await ownListing(req);
    if (l.published_at) throw badRequest("was_published", "Объявление уже было на сайте — его можно только убрать в архив");
    await db.query("DELETE FROM listings WHERE id = $1", [l.id]);
    await audit(req.user.id, "delete", "listing", l.id, { code: l.code, title: l.title });
    return { ok: true };
  });

  // ---------- Админка ----------

  const adminOnly = { preHandler: requireRole("admin") };

  async function anyListing(id) {
    const l = await L.getPrivate(id);
    if (!l) throw notFound("Объявление не найдено");
    return l;
  }

  app.get("/api/admin/listings", adminOnly, async (req) => {
    const where = [];
    const params = [];
    const m = req.query.moderation;
    if (m === "queue") where.push("(l.moderation = 'pending' OR l.pending_changes IS NOT NULL)");
    else if (m) {
      params.push(m);
      where.push(`l.moderation = $${params.length}`);
    }
    if (req.query.owner) {
      params.push(Number(req.query.owner));
      where.push(`l.owner_id = $${params.length}`);
    }
    const { rows } = await db.query(
      `${L.SELECT_PRIVATE} ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY l.floor, l.sort, l.id`,
      params
    );
    return { listings: rows.map(L.toPrivate) };
  });

  app.get("/api/admin/listings/:id", adminOnly, async (req) => ({
    listing: L.toPrivate(await anyListing(req.params.id)),
  }));

  app.post("/api/admin/listings", adminOnly, async (req) => {
    const fields = L.parseFields(req.body, { admin: true });
    if (!fields.title || !fields.floor || !fields.areaM2) {
      throw badRequest("required", "Заполните название, этаж и площадь");
    }
    await checkUploads(fields);
    const publish = req.body?.publish === true;
    const id = await db.transaction(async (client) =>
      L.insert(
        client,
        {
          code: await L.nextCode(fields.floor, client),
          moderation: publish ? "published" : "draft",
          published_at: publish ? new Date() : null,
        },
        { demo: false, ...fields }
      )
    );
    await audit(req.user.id, "create", "listing", id, { publish });
    return { listing: L.toPrivate(await L.getPrivate(id)) };
  });

  // Админ правит напрямую, в обход модерации.
  app.patch("/api/admin/listings/:id", adminOnly, async (req) => {
    const l = await anyListing(req.params.id);
    const fields = L.parseFields(req.body, { admin: true });
    await checkUploads(fields);
    if (fields.ownerId) {
      const owner = await db.one("SELECT role FROM users WHERE id = $1", [fields.ownerId]);
      if (!owner || !["landlord", "admin"].includes(owner.role)) throw badRequest("bad_owner", "Владелец должен быть собственником");
    }
    if (Object.keys(fields).length) await update(l.id, fields);
    await audit(req.user.id, "admin_edit", "listing", l.id, { fields: Object.keys(fields) });
    return { listing: L.toPrivate(await L.getPrivate(l.id)) };
  });

  app.post("/api/admin/listings/:id/approve", adminOnly, async (req) => {
    const l = await anyListing(req.params.id);
    if (l.pending_changes) {
      await update(l.id, l.pending_changes, "pending_changes = NULL, moderation_comment = ''");
    } else if (l.moderation === "pending") {
      await db.query(
        `UPDATE listings SET moderation = 'published', moderation_comment = '',
           published_at = coalesce(published_at, now()), updated_at = now() WHERE id = $1`,
        [l.id]
      );
    } else {
      throw badRequest("bad_state", "Нечего одобрять");
    }
    await audit(req.user.id, l.pending_changes ? "approve_changes" : "approve", "listing", l.id);
    notifyUser(l.owner_id, {
      subject: l.pending_changes ? "Правки объявления опубликованы" : "Объявление опубликовано",
      text: `Объявление ${label(l)} прошло модерацию и опубликовано на сайте.`,
      link: "/cabinet/#listings",
    });
    return { listing: L.toPrivate(await L.getPrivate(l.id)) };
  });

  app.post("/api/admin/listings/:id/reject", adminOnly, async (req) => {
    const l = await anyListing(req.params.id);
    const comment = str(req.body?.comment, 1000);
    if (!comment) throw badRequest("comment_required", "Напишите собственнику, что поправить");
    if (l.pending_changes) {
      await db.query(
        "UPDATE listings SET pending_changes = NULL, moderation_comment = $2, updated_at = now() WHERE id = $1",
        [l.id, comment]
      );
    } else if (l.moderation === "pending") {
      await db.query(
        "UPDATE listings SET moderation = 'rejected', moderation_comment = $2, updated_at = now() WHERE id = $1",
        [l.id, comment]
      );
    } else {
      throw badRequest("bad_state", "Нечего отклонять");
    }
    await audit(req.user.id, l.pending_changes ? "reject_changes" : "reject", "listing", l.id, { comment });
    notifyUser(l.owner_id, {
      subject: l.pending_changes ? "Правки объявления отклонены" : "Объявление отклонено",
      text: `Объявление ${label(l)} не прошло модерацию.\n\nКомментарий администратора: ${comment}`,
      link: "/cabinet/#listings",
    });
    return { listing: L.toPrivate(await L.getPrivate(l.id)) };
  });

  for (const [action, to] of [["archive", "archived"], ["unarchive", "published"]]) {
    app.post(`/api/admin/listings/:id/${action}`, adminOnly, async (req) => {
      const l = await anyListing(req.params.id);
      await db.query(
        `UPDATE listings SET moderation = $2, updated_at = now(),
           published_at = CASE WHEN $2 = 'published' THEN coalesce(published_at, now()) ELSE published_at END
         WHERE id = $1`,
        [l.id, to]
      );
      await audit(req.user.id, action, "listing", l.id, { from: l.moderation });
      return { listing: L.toPrivate(await L.getPrivate(l.id)) };
    });
  }

  app.delete("/api/admin/listings/:id", adminOnly, async (req) => {
    const l = await anyListing(req.params.id);
    await db.query("DELETE FROM listings WHERE id = $1", [l.id]);
    await audit(req.user.id, "delete", "listing", l.id, { code: l.code, title: l.title });
    return { ok: true };
  });
}

module.exports = routes;
