"use strict";

const db = require("../db");
const { randomToken } = require("../lib/security");
const { requireRole } = require("../lib/sessions");
const { TODAY, bump } = require("../lib/stats");
const { badRequest } = require("../lib/http");

const BOT_RE = /bot|crawl|spider|slurp|headless|lighthouse|preview/i;
const CLIENT_METRICS = {
  view: "site",
  contact: "site",
  impression: "listing",
  open: "listing",
  cta: "listing",
};

let salt = null;
async function getSalt() {
  if (salt) return salt;
  const row = await db.one("SELECT value FROM settings WHERE key = 'stats_salt'");
  if (row) return (salt = row.value);
  const fresh = randomToken(24);
  await db.query("INSERT INTO settings (key, value) VALUES ('stats_salt', $1) ON CONFLICT DO NOTHING", [
    JSON.stringify(fresh),
  ]);
  return (salt = (await db.one("SELECT value FROM settings WHERE key = 'stats_salt'")).value);
}

function parseRange(query) {
  const re = /^\d{4}-\d{2}-\d{2}$/;
  const to = re.test(query.to || "") ? query.to : null;
  const from = re.test(query.from || "") ? query.from : null;
  return { from, to };
}

// Отчёт за период: ряды по дням + таблица по объявлениям.
// ownerId = null — весь сайт (для админа), иначе только объявления собственника.
async function report(query, ownerId = null) {
  const { from, to } = parseRange(query);
  const range = await db.one(
    `SELECT coalesce($2::date, ${TODAY}) AS to_day,
            coalesce($1::date, coalesce($2::date, ${TODAY}) - 29) AS from_day`,
    [from, to]
  );
  const span = (new Date(range.to_day) - new Date(range.from_day)) / 86400000;
  if (span < 0 || span > 366) throw badRequest("bad_range", "Период — до года");

  const listingFilter = ownerId ? "l.owner_id = $3" : "TRUE";
  const params = [range.from_day, range.to_day, ...(ownerId ? [ownerId] : [])];

  const series = await db.query(
    `WITH days AS (SELECT generate_series($1::date, $2::date, '1 day')::date AS day),
     site AS (
       SELECT day, metric, sum(count)::int AS n FROM stats_daily
       WHERE day BETWEEN $1 AND $2 AND listing_id = 0 AND ${ownerId ? "FALSE" : "TRUE"}
       GROUP BY day, metric
     ),
     per_listing AS (
       SELECT s.day, s.metric, sum(s.count)::int AS n
       FROM stats_daily s JOIN listings l ON l.id = s.listing_id
       WHERE s.day BETWEEN $1 AND $2 AND ${listingFilter}
       GROUP BY s.day, s.metric
     )
     SELECT to_char(d.day, 'YYYY-MM-DD') AS day,
       coalesce((SELECT n FROM site WHERE site.day = d.day AND metric = 'view'), 0) AS view,
       coalesce((SELECT n FROM site WHERE site.day = d.day AND metric = 'visitor'), 0) AS visitor,
       coalesce((SELECT n FROM site WHERE site.day = d.day AND metric = 'contact'), 0) AS contact,
       coalesce((SELECT n FROM per_listing p WHERE p.day = d.day AND metric = 'impression'), 0) AS impression,
       coalesce((SELECT n FROM per_listing p WHERE p.day = d.day AND metric = 'open'), 0) AS open,
       coalesce((SELECT n FROM per_listing p WHERE p.day = d.day AND metric = 'cta'), 0) AS cta,
       ${
         ownerId
           ? "coalesce((SELECT n FROM per_listing p WHERE p.day = d.day AND metric = 'lead'), 0)"
           : "coalesce((SELECT n FROM site WHERE site.day = d.day AND metric = 'lead'), 0)"
       } AS lead
     FROM days d ORDER BY d.day`,
    params
  );

  const perListing = await db.query(
    `SELECT l.id, l.code, l.title, l.floor, l.moderation,
       coalesce(sum(s.count) FILTER (WHERE s.metric = 'impression'), 0)::int AS impression,
       coalesce(sum(s.count) FILTER (WHERE s.metric = 'open'), 0)::int AS open,
       coalesce(sum(s.count) FILTER (WHERE s.metric = 'cta'), 0)::int AS cta,
       coalesce(sum(s.count) FILTER (WHERE s.metric = 'lead'), 0)::int AS lead
     FROM listings l
     LEFT JOIN stats_daily s ON s.listing_id = l.id AND s.day BETWEEN $1 AND $2
     WHERE ${listingFilter} AND l.moderation IN ('published', 'archived')
     GROUP BY l.id ORDER BY l.floor, l.sort, l.id`,
    params
  );

  const days = series.rows;
  const totals = {};
  for (const k of ["view", "visitor", "contact", "impression", "open", "cta", "lead"]) {
    totals[k] = days.reduce((sum, d) => sum + d[k], 0);
  }
  return {
    from: days[0]?.day,
    to: days[days.length - 1]?.day,
    days,
    totals,
    listings: perListing.rows.map((r) => ({
      id: Number(r.id),
      code: r.code,
      title: r.title,
      floor: r.floor,
      moderation: r.moderation,
      impression: r.impression,
      open: r.open,
      cta: r.cta,
      lead: r.lead,
      // Конверсия: сколько открытий карточки закончились заявкой.
      conversion: r.open ? Math.round((r.lead / r.open) * 1000) / 10 : null,
    })),
  };
}

async function routes(app) {
  // Сайт шлёт события пачкой: { v: "<id посетителя>", events: [{ t: "open", l: "f8-01" }] }.
  // v — случайная строка из localStorage браузера; в базе хранится только её хеш с солью дня.
  app.post("/api/stats", { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } }, async (req) => {
    if (BOT_RE.test(req.headers["user-agent"] || "")) return { ok: true };
    const b = req.body || {};
    const events = Array.isArray(b.events) ? b.events.slice(0, 100) : [];
    const codes = [...new Set(events.map((e) => e && e.l).filter((c) => typeof c === "string"))];
    const ids = new Map();
    if (codes.length) {
      const { rows } = await db.query("SELECT id, code FROM listings WHERE code = ANY($1)", [codes]);
      for (const r of rows) ids.set(r.code, Number(r.id));
    }
    const counts = new Map();
    for (const e of events) {
      const scope = e && CLIENT_METRICS[e.t];
      if (!scope) continue;
      const listingId = scope === "site" ? 0 : ids.get(e.l);
      if (listingId === undefined) continue;
      const key = `${listingId}:${e.t}`;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    for (const [key, n] of counts) {
      const [listingId, metric] = key.split(":");
      await bump(Number(listingId), metric, n);
    }
    if (typeof b.v === "string" && b.v.length >= 8 && b.v.length <= 64) {
      // День входит в хеш: одного и того же человека нельзя связать между днями.
      const res = await db.query(
        `INSERT INTO stats_visitors (day, visitor_hash)
         VALUES (${TODAY}, encode(sha256(convert_to($1 || ':' || ${TODAY}::text, 'UTF8')), 'hex'))
         ON CONFLICT DO NOTHING`,
        [`${await getSalt()}:${b.v}`]
      );
      if (res.rowCount) await bump(0, "visitor");
    }
    return { ok: true };
  });

  app.get("/api/admin/stats", { preHandler: requireRole("admin") }, async (req) => report(req.query));
  app.get("/api/my/stats", { preHandler: requireRole("landlord") }, async (req) => report(req.query, req.user.id));
}

module.exports = routes;
module.exports.report = report;
