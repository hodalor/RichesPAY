import { Queue, Worker } from "bullmq";
import type { FastifyBaseLogger } from "fastify";

export const providerCallbacksQueueName = "provider-callbacks";

export interface ProviderCallbackJobData {
  callbackId: string;
}

export function createProviderCallbacksQueue(redisUrl: string) {
  return new Queue<ProviderCallbackJobData>(
    providerCallbacksQueueName,
    {
      connection: createBullMqConnection(redisUrl)
    }
  );
}

export function createProviderCallbacksWorker(
  redisUrl: string,
  processor: (data: ProviderCallbackJobData) => Promise<void>,
  logger?: FastifyBaseLogger
) {
  return new Worker<ProviderCallbackJobData>(
    providerCallbacksQueueName,
    async (job) => processor(job.data),
    {
      connection: createBullMqConnection(redisUrl),
      concurrency: 5
    }
  ).on("failed", (job, error) => {
    logger?.error(
      {
        callback_id: job?.data.callbackId,
        err: error
      },
      "Provider callback job failed"
    );
  });
}

function createBullMqConnection(redisUrl: string) {
  const parsed = new URL(redisUrl);
  const protocol = parsed.protocol === "rediss:" ? "tls" : undefined;
  const port = parsed.port ? Number(parsed.port) : 6379;

  return {
    host: parsed.hostname,
    password: parsed.password || undefined,
    port,
    tls: protocol === "tls" ? {} : undefined,
    username: parsed.username || undefined
  };
}
