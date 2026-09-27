"use strict";

const fs = require("node:fs");
const Fastify = require("fastify");
const config = require("./config");
const db = require("./db");
const { loadUser } = require("./lib/sessions");

async function buildApp(opts = {}) {
  const app = Fastify({
    logger: opts.logger ?? { level: config.isProduction ? "info" : "debug" },
    // За Caddy: настоящий IP клиента берём из X-Forwarded-For.
    trustProxy: true,
    bodyLimit: 1024 * 1024,
  });

  fs.mkdirSync(config.uploadsDir, { recursive: true });
  require("./lib/notify").setLogger(app.log);

  await app.register(require("@fastify/cookie"));
  await app.register(require("@fastify/multipart"), {
    limits: { fileSize: 15 * 1024 * 1024, files: 10 },
  });
  // Лимиты включаются точечно, в config маршрутов (вход, формы заявок).
  await app.register(require("@fastify/rate-limit"), {
    global: false,
    allowList: opts.noRateLimit ? () => true : undefined,
    errorResponseBuilder: () => ({
      statusCode: 429,
      code: "rate_limited",
      message: "Слишком много попыток, попробуйте через несколько минут",
    }),
  });

  // Защита от CSRF: cookie у нас SameSite=Lax, а изменяющие запросы к API
  // с чужих сайтов отсекаем по заголовку Origin. Свой сайт — это PUBLIC_URL или
  // тот адрес, по которому пришёл сам запрос (например, IP компьютера в локальной
  // сети, когда проверяют с телефона).
  const allowedOrigin = new URL(config.publicUrl).origin;
  app.addHook("onRequest", async (req, reply) => {
    if (!req.url.startsWith("/api/") || req.method === "GET" || req.method === "HEAD") return;
    const origin = req.headers.origin;
    if (!origin || origin === allowedOrigin || opts.allowAnyOrigin) return;
    let originHost = null;
    try {
      originHost = new URL(origin).host;
    } catch {
      originHost = null;
    }
    if (originHost && originHost === req.host) return;
    return reply.code(403).send({ error: "bad_origin", message: "Запрос с чужого сайта" });
  });

  app.addHook("onRequest", async (req) => {
    if (req.url.startsWith("/api/")) await loadUser(req);
  });

  app.setErrorHandler((err, req, reply) => {
    const status = err.statusCode || 500;
    if (status >= 500) req.log.error(err);
    const code = status >= 500 ? "server_error" : typeof err.code === "string" ? err.code : "bad_request";
    const message = status >= 500 ? "Ошибка на сервере, попробуйте ещё раз" : err.message;
    reply.code(status).send({ error: code, message });
  });

  app.get("/api/health", async () => {
    await db.query("SELECT 1");
    return { ok: true };
  });

  if (config.devOutbox) {
    const { outbox } = require("./lib/mail");
    app.get("/api/dev/outbox", async () => ({ messages: outbox.slice(-10).reverse() }));
  }

  await app.register(require("./routes/auth"));
  await app.register(require("./routes/me"));
  await app.register(require("./routes/listings"));
  await app.register(require("./routes/uploads"));
  await app.register(require("./routes/leads"));
  await app.register(require("./routes/stats"));
  await app.register(require("./routes/admin"));

  // Загруженные фото отдаём отдельным префиксом, чтобы не смешивать с файлами сайта.
  await app.register(require("@fastify/static"), {
    root: config.uploadsDir,
    prefix: "/uploads/",
    decorateReply: false,
    maxAge: "30d",
    immutable: true,
  });

  // Админка, кабинет собственника и страница входа.
  if (fs.existsSync(config.panelDir)) {
    await app.register(require("@fastify/static"), {
      root: config.panelDir,
      prefix: "/panel/",
      decorateReply: false,
      setHeaders: noCacheHtml,
    });
  }

  await app.register(require("@fastify/static"), {
    root: config.siteDir,
    prefix: "/",
    // /privacy → /privacy/ (папка с index.html).
    redirect: true,
    setHeaders: noCacheHtml,
  });

  for (const page of ["login", "admin", "cabinet"]) {
    app.get(`/${page}`, (req, reply) => reply.redirect(`/${page}/`));
    app.get(`/${page}/`, (req, reply) => {
      reply.header("Cache-Control", "no-cache");
      return reply.sendFile(`${page}.html`, config.panelDir);
    });
  }

  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith("/api/")) {
      return reply.code(404).send({ error: "not_found", message: "Не найдено" });
    }
    return reply.code(404).type("text/plain; charset=utf-8").send("Страница не найдена");
  });

  return app;
}

// HTML и JSON всегда перепроверяются браузером, чтобы правки были видны сразу.
function noCacheHtml(reply, filePath) {
  if (/\.(html|json|js|css)$/.test(filePath)) reply.header("Cache-Control", "no-cache");
}

module.exports = { buildApp };
