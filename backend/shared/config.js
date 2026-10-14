import "dotenv/config";

const localApiUrl = `http://${process.env.HOST || "127.0.0.1"}:${Number(process.env.PORT || 3000)}`;
const vercelUrl = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "";
const publicApiBaseUrl = (process.env.HOOKGUARD_PUBLIC_API_URL || vercelUrl || localApiUrl).replace(/\/+$/, "");

export const config = {
  host: process.env.HOST || "127.0.0.1",
  port: Number(process.env.PORT || 3000),
  databaseUrl:
    process.env.DATABASE_URL ||
    "postgres://hookguard:hookguard@127.0.0.1:5432/hookguard",
  redisUrl: process.env.REDIS_URL || "redis://127.0.0.1:6379",
  queueName: "hookguard-deliveries",
  apiKey: process.env.HOOKGUARD_API_KEY || (process.env.NODE_ENV === "production" ? "" : "hg_test_local_hookguard_key"),
  publicDemo: process.env.HOOKGUARD_PUBLIC_DEMO === "true" ||
    (process.env.NODE_ENV === "production" && process.env.HOOKGUARD_PUBLIC_DEMO !== "false"),
  requestTimeoutMs: Number(process.env.DELIVERY_TIMEOUT_MS || 3000),
  publicApiBaseUrl,
  receiverUrl(endpointId) {
    return `${publicApiBaseUrl}/api/receiver/delivery/${encodeURIComponent(endpointId)}`;
  }
};
