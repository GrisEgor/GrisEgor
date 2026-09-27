"use strict";

const db = require("../db");

function audit(userId, action, entity, entityId = "", meta = {}, client = db) {
  return client.query(
    "INSERT INTO audit_log (user_id, action, entity, entity_id, meta) VALUES ($1, $2, $3, $4, $5)",
    [userId || null, action, entity, String(entityId), JSON.stringify(meta)]
  );
}

module.exports = { audit };
