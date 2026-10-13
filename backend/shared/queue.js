import { Queue } from "bullmq";

import { config } from "./config.js";
import { createRedisConnection } from "./redis.js";

export const queueConnection = createRedisConnection();

export const deliveryQueue = new Queue(config.queueName, {
  connection: queueConnection,
  defaultJobOptions: {
    removeOnComplete: 500,
    removeOnFail: 500
  }
});

export function deliveryJobId(outboxId) {
  return `hookguard-delivery-${outboxId}`;
}

export async function enqueueDelivery(eventId, runNumber = 0, attemptNumber = 0, delay = 0, outboxId) {
  return deliveryQueue.add(
    "deliver-webhook",
    { eventId, runNumber, attemptNumber },
    {
      delay,
      jobId: deliveryJobId(outboxId)
    }
  );
}

export async function closeQueue() {
  await deliveryQueue.close();
  await queueConnection.quit();
}
