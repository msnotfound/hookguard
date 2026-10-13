import "dotenv/config";

export const config = {
  host: process.env.HOST || "127.0.0.1",
  port: Number(process.env.PORT || 3000),
  databaseUrl:
    process.env.DATABASE_URL ||
    "postgres://hookguard:hookguard@127.0.0.1:5432/hookguard",
  redisUrl: process.env.REDIS_URL || "redis://127.0.0.1:6379",
  queueName: "hookguard-deliveries",
  apiKey: process.env.HOOKGUARD_API_KEY || "hg_test_local_hookguard_key",
  requestTimeoutMs: Number(process.env.DELIVERY_TIMEOUT_MS || 3000)
};
