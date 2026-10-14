import { createHash } from "node:crypto";

const incrementWindow = `
  local count = redis.call('INCR', KEYS[1])
  if count == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
  return count
`;

export function createIpRateLimiter({ redis, namespace, limit, windowSeconds = 60 }) {
  return async function ipRateLimiter(req, res, next) {
    const ip = req.ip || req.socket?.remoteAddress || "unknown";
    const ipHash = createHash("sha256").update(ip).digest("hex").slice(0, 24);
    const windowNumber = Math.floor(Date.now() / 1000 / windowSeconds);
    const resetAt = (windowNumber + 1) * windowSeconds;
    const key = `${namespace}:${ipHash}:${windowNumber}`;

    try {
      const count = Number(await redis.eval(incrementWindow, 1, key, windowSeconds * 2));
      const remaining = Math.max(0, limit - count);
      res.set("RateLimit-Limit", String(limit));
      res.set("RateLimit-Remaining", String(remaining));
      res.set("RateLimit-Reset", String(resetAt));
      if (count > limit) {
        res.set("Retry-After", String(Math.max(1, resetAt - Math.floor(Date.now() / 1000))));
        return res.status(429).json({
          error: {
            code: "rate_limit_exceeded",
            message: `The shared demo accepts up to ${limit} changes per minute from one address. Try again shortly.`
          }
        });
      }
      return next();
    } catch (error) {
      return next(error);
    }
  };
}
