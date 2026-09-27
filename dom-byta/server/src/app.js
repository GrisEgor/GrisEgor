"use strict";

const fs = require("node:fs");
const Fastify = require("fastify");
const config = require("./config");
const db = require("./db");

async function buildApp(opts = {}) {
  const app = Fastify({
    logger: opts.logger ?? { level: config.isProduction ? "info" : "debug" },
    // За Caddy: настоящий IP клиента берём из X-Forwarded-For.
    trustProxy: true,
    bodyLimit: 1024 * 1024,
  });

  fs.mkdirSync(config.uploadsDir, { recursive: true });

  await app.register(require("@fastify/cookie"));

  app.get("/api/health", async () => {
    await db.query("SELECT 1");
    return { ok: true };
  });

  // Загруженные фото отдаём отдельным префиксом, чтобы не смешивать с файлами сайта.
  await app.register(require("@fastify/static"), {
    root: config.uploadsDir,
    prefix: "/uploads/",
    decorateReply: false,
    maxAge: "30d",
    immutable: true,
  });

  await app.register(require("@fastify/static"), {
    root: config.siteDir,
    prefix: "/",
    // HTML всегда перепроверяется, чтобы правки были видны сразу.
    setHeaders(reply, filePath) {
      if (filePath.endsWith(".html") || filePath.endsWith(".json")) {
        reply.header("Cache-Control", "no-cache");
      }
    },
  });

  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith("/api/")) {
      return reply.code(404).send({ error: "not_found" });
    }
    return reply.code(404).type("text/plain; charset=utf-8").send("Страница не найдена");
  });

  return app;
}

module.exports = { buildApp };
