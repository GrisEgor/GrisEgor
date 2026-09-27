"use strict";

const db = require("../db");
const { audit } = require("../lib/audit");
const { requireRole } = require("../lib/sessions");
const { notifyAdmins, notifyUser } = require("../lib/notify");
const { bump } = require("../lib/stats");
const { badRequest, notFound, str } = require("../lib/http");

const STATUSES = ["new", "in_progress", "viewing", "won", "lost", "spam"];
const STATUS_LABELS = {
  new: "новая",
  in_progress: "в работе",
  viewing: "просмотр",
  won: "договор",
  lost: "отказ",
  spam: "спам",
};

function toLead(r) {
  return {
    id: Number(r.id),
    kind: r.kind,
    listingId: r.listing_id ? Number(r.listing_id) : null,
    listingCode: r.listing_code || null,
    listingTitle: r.listing_title || null,
    landlordId: r.landlord_id ? Number(r.landlord_id) : null,
    landlordName: r.landlord_name || null,
    name: r.name,
    phone: r.phone,
    email: r.email,
    message: r.message,
    status: r.status,
    note: r.note,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const SELECT = `
  SELECT ld.*, l.code AS listing_code, l.title AS listing_title,
         coalesce(nullif(u.company, ''), nullif(u.name, ''), u.email) AS landlord_name
  FROM leads ld
  LEFT JOIN listings l ON l.id = ld.listing_id
  LEFT JOIN users u ON u.id = ld.landlord_id`;

function leadText(lead, listing) {
  const lines = [];
  if (listing) lines.push(`Помещение: «${listing.title}» (${listing.code}, этаж ${listing.floor}, ${Number(listing.area_m2)} м²)`);
  lines.push(`Имя: ${lead.name}`, `Телефон: ${lead.phone}`);
  if (lead.email) lines.push(`Почта: ${lead.email}`);
  if (lead.message) lines.push("", lead.message);
  return lines.join("\n");
}

async function routes(app) {
  // ---------- Форма на сайте ----------

  app.post("/api/leads", { config: { rateLimit: { max: 5, timeWindow: "10 minutes" } } }, async (req) => {
    const b = req.body || {};
    // Скрытое поле-ловушка: люди его не видят и не заполняют, боты — заполняют.
    if (b.website) return { ok: true };

    const name = str(b.name, 120);
    const phone = str(b.phone, 40);
    const email = str(b.email, 200);
    if (!name || !/\d{5,}/.test(phone.replace(/\D/g, ""))) {
      throw badRequest("required", "Укажите имя и телефон");
    }
    if (!(b.consent === true || b.consent === "on" || b.consent === "1")) {
      throw badRequest("consent_required", "Нужно согласие на обработку персональных данных");
    }

    let kind = "contact";
    let listing = null;
    const parts = [];
    if (b.kind === "owner") {
      kind = "owner";
      if (b.floor) parts.push(`Этаж: ${str(b.floor, 5)}`);
      if (b.area) parts.push(`Площадь: ${str(b.area, 10)} м²`);
      if (b.description) parts.push(str(b.description, 3000));
    } else {
      if (b.listing) {
        listing = await db.one("SELECT * FROM listings WHERE code = $1 AND moderation = 'published'", [
          str(b.listing, 20),
        ]);
      }
      if (listing) kind = "listing";
      else if (b.floor) parts.push(`Интересует этаж: ${str(b.floor, 5)}`);
      if (b.message) parts.push(str(b.message, 3000));
    }
    const message = parts.join("\n");

    const lead = await db.one(
      `INSERT INTO leads (kind, listing_id, landlord_id, user_id, name, phone, email, message)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [kind, listing?.id || null, listing?.owner_id || null, req.user?.id || null, name, phone, email, message]
    );
    await db.query("INSERT INTO lead_events (lead_id, to_status) VALUES ($1, 'new')", [lead.id]);
    await bump(listing ? listing.id : 0, "lead");
    if (listing) await bump(0, "lead");

    const text = leadText(lead, listing);
    const subject =
      kind === "owner" ? "Собственник хочет разместить объявление" : listing ? "Новая заявка на помещение" : "Новая заявка с сайта";
    if (listing?.owner_id) notifyUser(listing.owner_id, { subject, text, link: "/cabinet/#leads" });
    notifyAdmins({ subject, text, link: "/admin/#leads" });
    return { ok: true };
  });

  // ---------- Обработка: собственник и админ ----------

  async function changeLead(req, lead) {
    const b = req.body || {};
    const status = b.status !== undefined ? b.status : lead.status;
    if (!STATUSES.includes(status)) throw badRequest("bad_status", "Неизвестный статус");
    const note = b.note !== undefined ? str(b.note, 3000) : lead.note;
    let landlordId = lead.landlord_id;
    if (req.user.role === "admin" && b.landlordId !== undefined) {
      landlordId = b.landlordId ? Number(b.landlordId) : null;
      if (landlordId) {
        const u = await db.one("SELECT role FROM users WHERE id = $1", [landlordId]);
        if (!u || u.role !== "landlord") throw badRequest("bad_landlord", "Передать заявку можно только собственнику");
      }
    }
    await db.transaction(async (client) => {
      await client.query(
        "UPDATE leads SET status = $2, note = $3, landlord_id = $4, updated_at = now() WHERE id = $1",
        [lead.id, status, note, landlordId]
      );
      if (status !== lead.status) {
        await client.query(
          "INSERT INTO lead_events (lead_id, user_id, from_status, to_status, comment) VALUES ($1, $2, $3, $4, $5)",
          [lead.id, req.user.id, lead.status, status, str(b.comment, 1000)]
        );
      }
    });
    if (landlordId && Number(landlordId) !== Number(lead.landlord_id)) {
      await audit(req.user.id, "forward", "lead", lead.id, { to: landlordId });
      const listing = lead.listing_id ? await db.one("SELECT * FROM listings WHERE id = $1", [lead.listing_id]) : null;
      notifyUser(landlordId, {
        subject: "Вам передали заявку",
        text: leadText(lead, listing),
        link: "/cabinet/#leads",
      });
    }
    if (status !== lead.status) await audit(req.user.id, "lead_status", "lead", lead.id, { from: lead.status, to: status });
    return toLead(await db.one(`${SELECT} WHERE ld.id = $1`, [lead.id]));
  }

  async function events(leadId) {
    const { rows } = await db.query(
      `SELECT e.from_status, e.to_status, e.comment, e.created_at, u.name AS user_name
       FROM lead_events e LEFT JOIN users u ON u.id = e.user_id
       WHERE e.lead_id = $1 ORDER BY e.id`,
      [leadId]
    );
    return rows.map((r) => ({
      from: r.from_status,
      to: r.to_status,
      comment: r.comment,
      at: r.created_at,
      by: r.user_name || null,
    }));
  }

  function listQuery(req, baseWhere, baseParams) {
    const where = [...baseWhere];
    const params = [...baseParams];
    if (req.query.status && STATUSES.includes(req.query.status)) {
      params.push(req.query.status);
      where.push(`ld.status = $${params.length}`);
    } else if (req.query.status !== "all") {
      where.push("ld.status <> 'spam'");
    }
    if (req.query.kind) {
      params.push(req.query.kind);
      where.push(`ld.kind = $${params.length}`);
    }
    return { sql: `${SELECT} ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY ld.created_at DESC LIMIT 500`, params };
  }

  const landlordOnly = { preHandler: requireRole("landlord") };

  async function ownLead(req) {
    const lead = await db.one("SELECT * FROM leads WHERE id = $1", [req.params.id]);
    if (!lead || Number(lead.landlord_id) !== Number(req.user.id)) throw notFound("Заявка не найдена");
    return lead;
  }

  app.get("/api/my/leads", landlordOnly, async (req) => {
    const q = listQuery(req, ["ld.landlord_id = $1"], [req.user.id]);
    return { leads: (await db.query(q.sql, q.params)).rows.map(toLead), statuses: STATUS_LABELS };
  });

  app.get("/api/my/leads/:id", landlordOnly, async (req) => {
    const lead = await ownLead(req);
    return { lead: toLead(await db.one(`${SELECT} WHERE ld.id = $1`, [lead.id])), events: await events(lead.id) };
  });

  app.patch("/api/my/leads/:id", landlordOnly, async (req) => ({ lead: await changeLead(req, await ownLead(req)) }));

  const adminOnly = { preHandler: requireRole("admin") };

  async function anyLead(id) {
    const lead = await db.one("SELECT * FROM leads WHERE id = $1", [id]);
    if (!lead) throw notFound("Заявка не найдена");
    return lead;
  }

  app.get("/api/admin/leads", adminOnly, async (req) => {
    const q = listQuery(req, [], []);
    return { leads: (await db.query(q.sql, q.params)).rows.map(toLead), statuses: STATUS_LABELS };
  });

  app.get("/api/admin/leads/:id", adminOnly, async (req) => {
    const lead = await anyLead(req.params.id);
    return { lead: toLead(await db.one(`${SELECT} WHERE ld.id = $1`, [lead.id])), events: await events(lead.id) };
  });

  app.patch("/api/admin/leads/:id", adminOnly, async (req) => ({ lead: await changeLead(req, await anyLead(req.params.id)) }));
}

module.exports = routes;
module.exports.STATUS_LABELS = STATUS_LABELS;
