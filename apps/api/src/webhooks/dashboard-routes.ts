import { z } from "zod";

import type { FastifyTypedInstance } from "../types";

import type {
  WebhookDeliveryRecord,
  WebhookDispatchResult,
  WebhookEndpointRecord
} from "./types";
import { WebhookService } from "./service";

const webhookEventsSchema = z
  .array(z.string().min(1))
  .min(1)
  .refine(
    (value) => {
      const unique = [...new Set(value)];
      return !unique.includes("*") || unique.length === 1;
    },
    {
      message: "Use '*' by itself or provide explicit event names."
    }
  );

const httpsUrlSchema = z.string().url().refine((value) => value.startsWith("https://"), {
  message: "Webhook URLs must use HTTPS."
});

const endpointResponseSchema = z.object({
  consecutive_failures: z.number().int().min(0),
  created_at: z.string().datetime(),
  description: z.string(),
  enabled: z.boolean(),
  events: z.array(z.string()),
  id: z.string(),
  mode: z.enum(["test", "live"]),
  updated_at: z.string().datetime(),
  url: z.string().url()
});

const deliveryResponseSchema = z.object({
  attempt: z.number().int().positive(),
  created_at: z.string().datetime(),
  delivered_at: z.string().datetime().nullable(),
  disabled_endpoint: z.boolean(),
  duration_ms: z.number().int().nullable(),
  endpoint_consecutive_failures: z.number().int().min(0),
  endpoint_id: z.string(),
  event_id: z.string(),
  event_type: z.string(),
  mode: z.enum(["test", "live"]),
  next_retry_at: z.string().datetime().nullable(),
  response_snippet: z.string().nullable(),
  status_code: z.number().int().nullable()
});

const deliveryListItemSchema = z.object({
  attempt: z.number().int().positive(),
  created_at: z.string().datetime(),
  delivered_at: z.string().datetime().nullable(),
  duration_ms: z.number().int().nullable(),
  endpoint_id: z.string(),
  event_id: z.string(),
  event_type: z.string(),
  mode: z.enum(["test", "live"]),
  next_retry_at: z.string().datetime().nullable(),
  response_snippet: z.string().nullable(),
  status_code: z.number().int().nullable()
});

export async function registerWebhookDashboardRoutes(app: FastifyTypedInstance) {
  const webhookService = new WebhookService({
    database: app.db,
    encryptionKey: app.appEnv.ENCRYPTION_KEY,
    logger: app.log
  });

  app.get(
    "/webhooks",
    {
      schema: {
        response: {
          200: z.object({
            data: z.array(endpointResponseSchema)
          })
        }
      }
    },
    async (request) => {
      request.assertDashboardPermission("webhooks.manage");

      const endpoints = await webhookService.listEndpoints(
        request.dashboardMembership!.merchantId,
        request.dashboardMembership!.mode
      );

      return {
        data: endpoints.map(serializeEndpoint)
      };
    }
  );

  app.post(
    "/webhooks",
    {
      schema: {
        body: z.object({
          description: z.string().min(1),
          enabled: z.boolean().optional(),
          events: webhookEventsSchema,
          url: httpsUrlSchema
        }),
        response: {
          201: z.object({
            data: z.object({
              endpoint: endpointResponseSchema,
              signing_secret: z.string()
            })
          })
        }
      }
    },
    async (request, reply) => {
      request.assertDashboardPermission("webhooks.manage");

      const created = await webhookService.createEndpoint({
        description: request.body.description,
        events: request.body.events,
        merchantId: request.dashboardMembership!.merchantId,
        mode: request.dashboardMembership!.mode,
        ...(request.body.enabled !== undefined
          ? { enabled: request.body.enabled }
          : {}),
        url: request.body.url
      });

      return reply.status(201).send({
        data: {
          endpoint: serializeEndpoint(created.endpoint),
          signing_secret: created.signingSecret
        }
      });
    }
  );

  app.put(
    "/webhooks/:endpointId",
    {
      schema: {
        body: z.object({
          description: z.string().min(1),
          enabled: z.boolean(),
          events: webhookEventsSchema,
          url: httpsUrlSchema
        }),
        params: z.object({
          endpointId: z.string().min(1)
        }),
        response: {
          200: z.object({
            data: endpointResponseSchema
          })
        }
      }
    },
    async (request) => {
      request.assertDashboardPermission("webhooks.manage");

      const updated = await webhookService.updateEndpoint({
        description: request.body.description,
        enabled: request.body.enabled,
        endpointId: request.params.endpointId,
        events: request.body.events,
        merchantId: request.dashboardMembership!.merchantId,
        mode: request.dashboardMembership!.mode,
        url: request.body.url
      });

      return {
        data: serializeEndpoint(updated)
      };
    }
  );

  app.post(
    "/webhooks/:endpointId/roll-secret",
    {
      schema: {
        params: z.object({
          endpointId: z.string().min(1)
        }),
        response: {
          200: z.object({
            data: z.object({
              endpoint: endpointResponseSchema,
              signing_secret: z.string()
            })
          })
        }
      }
    },
    async (request) => {
      request.assertDashboardPermission("webhooks.manage");

      const rolled = await webhookService.rollSecret({
        endpointId: request.params.endpointId,
        merchantId: request.dashboardMembership!.merchantId,
        mode: request.dashboardMembership!.mode
      });

      return {
        data: {
          endpoint: serializeEndpoint(rolled.endpoint),
          signing_secret: rolled.signingSecret
        }
      };
    }
  );

  app.post(
    "/webhooks/:endpointId/test",
    {
      schema: {
        params: z.object({
          endpointId: z.string().min(1)
        }),
        response: {
          200: z.object({
            data: deliveryResponseSchema
          })
        }
      }
    },
    async (request) => {
      request.assertDashboardPermission("webhooks.manage");

      const delivery = await webhookService.sendTestEvent({
        endpointId: request.params.endpointId,
        merchantId: request.dashboardMembership!.merchantId,
        mode: request.dashboardMembership!.mode
      });

      return {
        data: serializeDispatchResult(delivery)
      };
    }
  );

  app.get(
    "/webhooks/deliveries",
    {
      schema: {
        querystring: z.object({
          endpoint_id: z.string().min(1).optional(),
          limit: z.coerce.number().int().positive().max(100).default(20)
        }),
        response: {
          200: z.object({
            data: z.array(deliveryListItemSchema)
          })
        }
      }
    },
    async (request) => {
      request.assertDashboardPermission("webhooks.manage");

      const deliveries = await webhookService.listDeliveries(
        request.dashboardMembership!.merchantId,
        request.dashboardMembership!.mode,
        {
          ...(request.query.endpoint_id
            ? { endpointId: request.query.endpoint_id }
            : {}),
          limit: request.query.limit
        }
      );

      return {
        data: deliveries.map(serializeDelivery)
      };
    }
  );

  app.post(
    "/webhooks/:endpointId/deliveries/:eventId/replay",
    {
      schema: {
        params: z.object({
          endpointId: z.string().min(1),
          eventId: z.string().min(1)
        }),
        response: {
          200: z.object({
            data: deliveryResponseSchema
          })
        }
      }
    },
    async (request) => {
      request.assertDashboardPermission("webhooks.manage");

      const delivery = await webhookService.replayDelivery({
        endpointId: request.params.endpointId,
        eventId: request.params.eventId,
        merchantId: request.dashboardMembership!.merchantId,
        mode: request.dashboardMembership!.mode
      });

      return {
        data: serializeDispatchResult(delivery)
      };
    }
  );
}

function serializeEndpoint(endpoint: WebhookEndpointRecord) {
  return {
    consecutive_failures: endpoint.consecutiveFailures,
    created_at: endpoint.createdAt.toISOString(),
    description: endpoint.description,
    enabled: endpoint.enabled,
    events: endpoint.events,
    id: endpoint.id,
    mode: endpoint.mode,
    updated_at: endpoint.updatedAt.toISOString(),
    url: endpoint.url
  };
}

function serializeDelivery(delivery: WebhookDeliveryRecord) {
  return {
    attempt: delivery.attempt,
    created_at: delivery.createdAt.toISOString(),
    delivered_at: delivery.deliveredAt?.toISOString() ?? null,
    duration_ms: delivery.durationMs,
    endpoint_id: delivery.endpointId,
    event_id: delivery.eventId,
    event_type: delivery.eventType,
    mode: delivery.mode,
    next_retry_at: delivery.nextRetryAt?.toISOString() ?? null,
    response_snippet: delivery.responseSnippet,
    status_code: delivery.statusCode
  };
}

function serializeDispatchResult(delivery: WebhookDispatchResult) {
  return {
    ...serializeDelivery(delivery),
    disabled_endpoint: delivery.disabledEndpoint,
    endpoint_consecutive_failures: delivery.endpointConsecutiveFailures
  };
}
