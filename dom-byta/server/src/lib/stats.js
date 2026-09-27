"use strict";

const db = require("../db");

// Дни считаем по Челябинску (UTC+5).
const TZ = "Asia/Yekaterinburg";
const TODAY = `(now() AT TIME ZONE '${TZ}')::date`;

// События с сайта. listing_id = 0 — события сайта целиком.
//   view — открыта страница; visitor — новый посетитель за день;
//   impression — карточка попала в экран; open — открыли «Подробнее»;
//   cta — нажали «Оставить заявку» у объявления; contact — клик по телефону/Telegram/почте;
//   lead — заявка сохранена (считает сервер).
const METRICS = ["view", "visitor", "impression", "open", "cta", "contact", "lead"];

async function bump(listingId, metric, n = 1, client = db) {
  await client.query(
    `INSERT INTO stats_daily (day, listing_id, metric, count) VALUES (${TODAY}, $1, $2, $3)
     ON CONFLICT (day, listing_id, metric) DO UPDATE SET count = stats_daily.count + EXCLUDED.count`,
    [listingId, metric, n]
  );
}

module.exports = { TZ, TODAY, METRICS, bump };
