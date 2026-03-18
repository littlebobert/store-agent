import "dotenv/config";

import { PostgresStore } from "@store-agent/core";

import { loadApiConfig } from "./config.js";

async function main(): Promise<void> {
  const config = loadApiConfig();
  const store = new PostgresStore(config.DATABASE_URL);

  try {
    await store.migrate();
    console.log("Database migrations applied.");
  } finally {
    await store.close();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
