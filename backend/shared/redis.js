import IORedis from "ioredis";

import { config } from "./config.js";

export function createRedisConnection() {
  return new IORedis(config.redisUrl, {
    maxRetriesPerRequest: null
  });
}
