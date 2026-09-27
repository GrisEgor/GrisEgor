"use strict";

const { Pool } = require("pg");
const config = require("./config");

const pool = new Pool({ connectionString: config.databaseUrl, max: 10 });

function query(text, params) {
  return pool.query(text, params);
}

async function one(text, params) {
  const res = await pool.query(text, params);
  return res.rows[0] || null;
}

async function transaction(fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// При запуске в Docker база может подняться позже приложения.
async function waitForDatabase(log, attempts = 30) {
  for (let i = 1; ; i++) {
    try {
      await pool.query("SELECT 1");
      return;
    } catch (err) {
      if (i >= attempts) throw err;
      log.info(`База недоступна (${err.code || err.message}), повтор через 1 с…`);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

module.exports = { pool, query, one, transaction, waitForDatabase };
