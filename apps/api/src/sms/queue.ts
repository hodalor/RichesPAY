import { Queue, Worker } from "bullmq";
import type { FastifyBaseLogger } from "fastify";

export const smsMessagesQueueName = "sms-messages";

export interface SmsMessageJobData {
  smsMessageId: string;
}

export function createSmsMessagesQueue(redisUrl: string) {
  return new Queue<SmsMessageJobData>(smsMessagesQueueName, {
    connection: createBullMqConnection(redisUrl)
  });
}

export function createSmsMessagesWorker(
  redisUrl: string,
  processor: (data: SmsMessageJobData) => Promise<void>,
  logger?: FastifyBaseLogger
) {
  return new Worker<SmsMessageJobData>(
    smsMessagesQueueName,
    async (job) => processor(job.data),
    {
      connection: createBullMqConnection(redisUrl),
      concurrency: 1
    }
  ).on("failed", (job, error) => {
    logger?.error(
      {
        err: error,
        sms_message_id: job?.data.smsMessageId
      },
      "SMS message job failed"
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
