"use strict";

const fs = require("node:fs");
const path = require("node:path");
const config = require("./config");
const db = require("./db");

const migrationsDir = path.join(__dirname, "migrations");

// Каждый файл migrations/NNN_*.sql выполняется один раз, в своей транзакции.
async function runMigrations(log) {
  await db.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name       text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);
  const applied = new Set(
    (await db.query("SELECT name FROM schema_migrations")).rows.map((r) => r.name)
  );
  const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(migrationsDir, file), "utf8");
    await db.transaction(async (client) => {
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
    });
    log.info(`Миграция применена: ${file}`);
  }
}

// Первый запуск: переносим объявления из site/data/listings.json, чтобы сайт
// сразу показывал то же, что и статическая версия. Если в таблице уже что-то
// есть, ничего не трогаем — дальше объявления ведутся через кабинеты.
async function importListings(log) {
  const { rows } = await db.query("SELECT count(*)::int AS n FROM listings");
  if (rows[0].n > 0) return;
  const file = path.join(config.siteDir, "data", "listings.json");
  if (!fs.existsSync(file)) return;
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  const listings = data.listings || [];
  await db.transaction(async (client) => {
    for (const [i, l] of listings.entries()) {
      await client.query(
        `INSERT INTO listings (code, owner_label, floor, title, type, area_m2, price_per_m2,
           description, availability, floor_plan, photos, demo, moderation, sort, published_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'published', $13, now())`,
        [
          l.id,
          l.owner || "",
          l.floor,
          l.title,
          l.type || "",
          l.areaM2,
          l.pricePerM2,
          l.description || "",
          l.status || "available",
          l.floorPlan || "",
          JSON.stringify(l.photos || []),
          l.demo !== false,
          i,
        ]
      );
    }
  });
  log.info(`Импортировано объявлений из listings.json: ${listings.length}`);
}

async function migrate(log) {
  await runMigrations(log);
  await importListings(log);
}

module.exports = { migrate };

if (require.main === module) {
  const log = { info: (m) => console.log(m) };
  db.waitForDatabase(log)
    .then(() => migrate(log))
    .then(() => db.pool.end())
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
