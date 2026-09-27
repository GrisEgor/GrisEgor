"use strict";

const config = require("./config");
const db = require("./db");
const { migrate } = require("./migrate");
const { buildApp } = require("./app");

async function main() {
  const app = await buildApp();
  await db.waitForDatabase(app.log);
  await migrate(app.log);
  await app.listen({ port: config.port, host: config.host });

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, async () => {
      app.log.info(`${signal}: останавливаемся`);
      await app.close();
      await db.pool.end();
      process.exit(0);
    });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
