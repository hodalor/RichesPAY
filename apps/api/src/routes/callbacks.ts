import { z } from "zod";

import type { FastifyTypedInstance } from "../types";
import { ProviderCallbackService, ProviderCatalog, getCallbackClientIp } from "../providers";

export async function registerCallbackRoutes(app: FastifyTypedInstance) {
  const catalog = new ProviderCatalog({
    database: app.db,
    encryptionKey: app.appEnv.ENCRYPTION_KEY
  });
  const callbackService = new ProviderCallbackService({
    catalog,
    database: app.db,
    logger: app.log,
    redisUrl: app.appEnv.REDIS_URL
  });

  app.addHook("onClose", async () => {
    await callbackService.close();
  });

  app.addContentTypeParser(
    "*",
    {
      parseAs: "string"
    },
    (_request, body, done) => {
      done(null, body);
    }
  );

  app.post(
    "/:channelId",
    {
      schema: {
        params: z.object({
          channelId: z.string().min(1)
        }),
        response: {
          200: z.object({
            data: z.object({
              received: z.literal(true)
            })
          })
        }
      }
    },
    async (request, reply) => {
      const { channelId } = z.object({
        channelId: z.string().min(1)
      }).parse(request.params);

      const rawBody =
        typeof request.body === "string"
          ? request.body
          : JSON.stringify(request.body ?? {});

      const normalizedHeaders = Object.fromEntries(
        Object.entries(request.headers).map(([key, value]) => [
          key,
          Array.isArray(value)
            ? value.map((entry) => String(entry))
            : value === undefined
              ? undefined
              : String(value)
        ])
      );

      await callbackService.handleInboundCallback({
        channelId,
        headers: normalizedHeaders,
        ip: getCallbackClientIp(normalizedHeaders, request.ip),
        rawBody
      });

      return reply.status(200).send({
        data: {
          received: true
        }
      });
    }
  );
}
