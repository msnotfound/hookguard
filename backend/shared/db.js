import pg from "pg";

import { config } from "./config.js";

export const pool = new pg.Pool({
  connectionString: config.databaseUrl
});

export async function query(text, params = []) {
  return pool.query(text, params);
}

export async function closeDb() {
  await pool.end();
}
