"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const sharp = require("sharp");
const config = require("../config");
const db = require("../db");
const { requireRole } = require("../lib/sessions");
const { badRequest } = require("../lib/http");

const MAX_SIDE = 1920;
const THUMB_SIDE = 480;

// Фото приводим к webp: поворот по EXIF, без метаданных (в EXIF бывают координаты),
// не больше 1920 px по длинной стороне, плюс превью для списков в кабинете.
async function saveImage(buffer, userId) {
  let image;
  try {
    image = sharp(buffer, { failOn: "error" }).rotate();
    await image.metadata();
  } catch {
    throw badRequest("bad_image", "Не удалось прочитать изображение — загрузите JPG, PNG или WebP");
  }
  const id = crypto.randomUUID();
  const now = new Date();
  const dir = `${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  await fs.mkdir(path.join(config.uploadsDir, dir), { recursive: true });

  const full = await image
    .clone()
    .resize(MAX_SIDE, MAX_SIDE, { fit: "inside", withoutEnlargement: true })
    .webp({ quality: 82 })
    .toBuffer({ resolveWithObject: true });
  const thumb = await image
    .clone()
    .resize(THUMB_SIDE, THUMB_SIDE, { fit: "inside", withoutEnlargement: true })
    .webp({ quality: 75 })
    .toBuffer();

  const rel = `${dir}/${id}.webp`;
  const relThumb = `${dir}/${id}-thumb.webp`;
  await fs.writeFile(path.join(config.uploadsDir, rel), full.data);
  await fs.writeFile(path.join(config.uploadsDir, relThumb), thumb);

  const row = {
    id,
    path: `/uploads/${rel}`,
    thumb_path: `/uploads/${relThumb}`,
    width: full.info.width,
    height: full.info.height,
    bytes: full.info.size,
  };
  await db.query(
    `INSERT INTO uploads (id, user_id, path, thumb_path, width, height, bytes)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [row.id, userId, row.path, row.thumb_path, row.width, row.height, row.bytes]
  );
  return { id, url: row.path, thumb: row.thumb_path, width: row.width, height: row.height };
}

async function routes(app) {
  app.post(
    "/api/uploads",
    { preHandler: requireRole("landlord", "admin"), config: { rateLimit: { max: 100, timeWindow: "10 minutes" } } },
    async (req) => {
      if (!req.isMultipart()) throw badRequest("not_multipart", "Ожидается загрузка файла");
      const files = [];
      try {
        for await (const part of req.files()) {
          files.push(await saveImage(await part.toBuffer(), req.user.id));
        }
      } catch (err) {
        if (err.code === "FST_REQ_FILE_TOO_LARGE") throw badRequest("too_large", "Файл больше 15 МБ");
        if (err.code === "FST_FILES_LIMIT") throw badRequest("too_many", "Не больше 10 файлов за раз");
        throw err;
      }
      if (!files.length) throw badRequest("no_files", "Выберите фото");
      return { files };
    }
  );
}

module.exports = routes;
module.exports.saveImage = saveImage;
