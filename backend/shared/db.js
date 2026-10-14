import pg from "pg";

import { config } from "./config.js";

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: Number(process.env.PG_POOL_MAX || (process.env.NODE_ENV === "production" ? 1 : 3)),
  idleTimeoutMillis: 10000,
  connectionTimeoutMillis: 5000
});

export async function query(text, params = []) {
  return pool.query(text, params);
}

export async function closeDb() {
  await pool.end();
}
