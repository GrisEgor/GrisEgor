"use strict";

const db = require("../db");
const { audit } = require("../lib/audit");
const { requireRole } = require("../lib/sessions");
const { notifyUser } = require("../lib/notify");
const { publicUser } = require("../lib/users");
const { TODAY } = require("../lib/stats");
const { badRequest, notFound, str } = require("../lib/http");

const ROLES = ["admin", "landlord", "tenant"];
const USER_STATUSES = ["active", "pending", "blocked"];

// Настройки, которые можно менять из админки, и их проверка.
const SETTINGS = {
  metrikaId: (v) => {
    const s = str(String(v ?? ""), 20);
    if (s && !/^\d{5,12}$/.test(s)) throw badRequest("bad_metrika", "Номер счётчика Метрики — только цифры");
    return s;
  },
};

async function getSettings() {
  const { rows } = await db.query("SELECT key, value FROM settings WHERE key = ANY($1)", [Object.keys(SETTINGS)]);
  const out = { metrikaId: "" };
  for (const r of rows) out[r.key] = r.value;
  return out;
}

async function routes(app) {
  // Публичные настройки для сайта (номер счётчика Метрики).
  app.get("/api/settings", async (req, reply) => {
    reply.header("Cache-Control", "no-cache");
    const s = await getSettings();
    return { metrikaId: s.metrikaId };
  });

  // Всё ниже — только для администратора. Плагин инкапсулирован, хук действует только здесь.
  app.register(async (admin) => {
    admin.addHook("preHandler", requireRole("admin"));

    admin.get("/api/admin/dashboard", async () => {
      const counts = await db.one(`
        SELECT
          (SELECT count(*) FROM listings WHERE moderation = 'pending' OR pending_changes IS NOT NULL)::int AS moderation,
          (SELECT count(*) FROM users WHERE role = 'landlord' AND status = 'pending')::int AS pending_landlords,
          (SELECT count(*) FROM leads WHERE status = 'new')::int AS new_leads,
          (SELECT count(*) FROM listings WHERE moderation = 'published')::int AS published,
          (SELECT count(*) FROM listings WHERE moderation = 'published' AND availability = 'available')::int AS available,
          (SELECT count(*) FROM users WHERE role = 'landlord' AND status = 'active')::int AS landlords`);
      const week = await db.one(
        `SELECT
           coalesce(sum(count) FILTER (WHERE metric = 'view' AND listing_id = 0), 0)::int AS views,
           coalesce(sum(count) FILTER (WHERE metric = 'visitor' AND listing_id = 0), 0)::int AS visitors,
           coalesce(sum(count) FILTER (WHERE metric = 'open'), 0)::int AS opens,
           coalesce(sum(count) FILTER (WHERE metric = 'lead' AND listing_id = 0), 0)::int AS leads
         FROM stats_daily WHERE day > ${TODAY} - 7`
      );
      const recentLeads = await db.query(
        `SELECT ld.id, ld.name, ld.kind, ld.status, ld.created_at, l.code AS listing_code, l.title AS listing_title
         FROM leads ld LEFT JOIN listings l ON l.id = ld.listing_id
         WHERE ld.status <> 'spam' ORDER BY ld.created_at DESC LIMIT 5`
      );
      return {
        counts: {
          moderation: counts.moderation,
          pendingLandlords: counts.pending_landlords,
          newLeads: counts.new_leads,
          published: counts.published,
          available: counts.available,
          landlords: counts.landlords,
        },
        week,
        recentLeads: recentLeads.rows.map((r) => ({
          id: Number(r.id),
          name: r.name,
          kind: r.kind,
          status: r.status,
          createdAt: r.created_at,
          listingCode: r.listing_code,
          listingTitle: r.listing_title,
        })),
      };
    });

    // ---------- Пользователи ----------

    admin.get("/api/admin/users", async (req) => {
      const where = [];
      const params = [];
      if (ROLES.includes(req.query.role)) {
        params.push(req.query.role);
        where.push(`u.role = $${params.length}`);
      }
      if (USER_STATUSES.includes(req.query.status)) {
        params.push(req.query.status);
        where.push(`u.status = $${params.length}`);
      }
      if (req.query.q) {
        params.push(`%${str(req.query.q, 100)}%`);
        where.push(`(u.email ILIKE $${params.length} OR u.name ILIKE $${params.length} OR u.phone ILIKE $${params.length} OR u.company ILIKE $${params.length})`);
      }
      const { rows } = await db.query(
        `SELECT u.*,
           coalesce((SELECT array_agg(provider ORDER BY provider) FROM identities i WHERE i.user_id = u.id), '{}') AS providers,
           (SELECT count(*) FROM listings l WHERE l.owner_id = u.id)::int AS listings_count
         FROM users u ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
         ORDER BY (u.status = 'pending') DESC, u.created_at DESC LIMIT 500`,
        params
      );
      return {
        users: rows.map((u) => ({
          ...publicUser(u, u.providers),
          lastLoginAt: u.last_login_at,
          listingsCount: u.listings_count,
        })),
      };
    });

    admin.patch("/api/admin/users/:id", async (req) => {
      const u = await db.one("SELECT * FROM users WHERE id = $1", [req.params.id]);
      if (!u) throw notFound("Пользователь не найден");
      const b = req.body || {};
      const role = b.role !== undefined ? b.role : u.role;
      const status = b.status !== undefined ? b.status : u.status;
      if (!ROLES.includes(role) || !USER_STATUSES.includes(status)) throw badRequest("bad_value", "Неверная роль или статус");
      if (Number(u.id) === Number(req.user.id) && (role !== "admin" || status !== "active")) {
        throw badRequest("self", "Нельзя снять права или заблокировать самого себя");
      }
      await db.query(
        "UPDATE users SET role = $2, status = $3, name = $4, phone = $5, company = $6 WHERE id = $1",
        [
          u.id,
          role,
          status,
          b.name !== undefined ? str(b.name, 120) : u.name,
          b.phone !== undefined ? str(b.phone, 40) : u.phone,
          b.company !== undefined ? str(b.company, 200) : u.company,
        ]
      );
      if (status === "blocked" && u.status !== "blocked") {
        await db.query("DELETE FROM sessions WHERE user_id = $1", [u.id]);
      }
      await audit(req.user.id, "user_update", "user", u.id, {
        role: role !== u.role ? [u.role, role] : undefined,
        status: status !== u.status ? [u.status, status] : undefined,
      });
      if (role === "landlord" && u.status === "pending" && status === "active") {
        notifyUser(u.id, {
          subject: "Аккаунт собственника подтверждён",
          text: "Администратор подтвердил ваш аккаунт. Теперь объявления можно отправлять на модерацию.",
          link: "/cabinet/#listings",
        });
      }
      const fresh = await db.one("SELECT * FROM users WHERE id = $1", [u.id]);
      return { user: publicUser(fresh) };
    });

    // ---------- Журнал ----------

    admin.get("/api/admin/audit", async (req) => {
      const params = [Math.min(Number(req.query.limit) || 100, 500)];
      const where = [];
      if (req.query.before) {
        params.push(Number(req.query.before));
        where.push(`a.id < $${params.length}`);
      }
      if (req.query.entity) {
        params.push(str(req.query.entity, 20));
        where.push(`a.entity = $${params.length}`);
      }
      const { rows } = await db.query(
        `SELECT a.*, u.name AS user_name, u.email AS user_email
         FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
         ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
         ORDER BY a.id DESC LIMIT $1`,
        params
      );
      return {
        entries: rows.map((r) => ({
          id: Number(r.id),
          at: r.created_at,
          user: r.user_id ? { id: Number(r.user_id), name: r.user_name, email: r.user_email } : null,
          action: r.action,
          entity: r.entity,
          entityId: r.entity_id,
          meta: r.meta,
        })),
      };
    });

    // ---------- Настройки ----------

    admin.get("/api/admin/settings", async () => ({ settings: await getSettings() }));

    admin.put("/api/admin/settings", async (req) => {
      const b = req.body || {};
      for (const [key, parse] of Object.entries(SETTINGS)) {
        if (b[key] === undefined) continue;
        const value = parse(b[key]);
        await db.query(
          "INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
          [key, JSON.stringify(value)]
        );
        await audit(req.user.id, "setting", "settings", key, { value });
      }
      return { settings: await getSettings() };
    });
  });
}

module.exports = routes;
