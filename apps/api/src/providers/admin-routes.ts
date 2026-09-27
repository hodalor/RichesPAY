import { z } from "zod";

import { newId } from "@richespay/shared";

import { runWithSystemScope } from "../db";
import { runAdminSystemWrite } from "../auth/admin-access";
import type { Json } from "../db/types";
import type { FastifyTypedInstance } from "../types";
import { CredentialEncryptionService } from "./crypto";
import {
  channelCapabilities,
  channelHealthStates,
  channelKinds,
  channelStatuses
} from "./types";

const channelResponseSchema = z.object({
  capabilities: z.array(z.enum(channelCapabilities)),
  config: z.unknown(),
  country_code: z.string(),
  created_at: z.string(),
  has_credentials: z.boolean(),
  health: z.enum(channelHealthStates),
  id: z.string(),
  kind: z.enum(channelKinds),
  mode: z.enum(["test", "live"]),
  network: z.string().nullable(),
  priority: z.number().int(),
  provider_code: z.string(),
  status: z.enum(channelStatuses),
  updated_at: z.string()
});

const createChannelBodySchema = z.object({
  capabilities: z.array(z.enum(channelCapabilities)).min(1),
  config: z.record(z.string(), z.unknown()).default({}),
  country_code: z.string().min(2),
  credentials: z.record(z.string(), z.unknown()),
  health: z.enum(channelHealthStates).default("healthy"),
  kind: z.enum(channelKinds),
  mode: z.enum(["test", "live"]),
  network: z.string().min(1).optional(),
  priority: z.number().int().min(0),
  provider_code: z.string().min(1),
  reason: z.string().min(1),
  status: z.enum(channelStatuses).default("active")
});

const updateChannelBodySchema = z.object({
  capabilities: z.array(z.enum(channelCapabilities)).min(1).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  country_code: z.string().min(2).optional(),
  credentials: z.record(z.string(), z.unknown()).optional(),
  health: z.enum(channelHealthStates).optional(),
  network: z.string().min(1).nullable().optional(),
  priority: z.number().int().min(0).optional(),
  provider_code: z.string().min(1).optional(),
  reason: z.string().min(1),
  status: z.enum(channelStatuses).optional()
});

const setChannelStatusBodySchema = z.object({
  reason: z.string().min(1),
  status: z.enum(channelStatuses)
});

const reorderRoutingRuleBodySchema = z.object({
  capability: z.enum(channelCapabilities),
  channel_ids: z.array(z.string().min(1)).min(1),
  country_code: z.string().min(2),
  kind: z.enum(channelKinds),
  network: z.string().min(1).nullable().optional(),
  reason: z.string().min(1)
});

const upsertMsisdnPrefixBodySchema = z.object({
  country_code: z.string().min(2),
  network: z.string().min(1),
  prefix: z.string().min(1),
  reason: z.string().min(1)
});

type ChannelResponse = z.infer<typeof channelResponseSchema>;

export async function registerProviderAdminRoutes(app: FastifyTypedInstance) {
  const encryption = new CredentialEncryptionService(app.appEnv.ENCRYPTION_KEY);

  app.get(
    "/channels",
    {
      schema: {
        response: {
          200: z.object({
            data: z.array(channelResponseSchema)
          })
        }
      }
    },
    async () => {
      const channels = await runWithSystemScope(
        app.db,
        "list provider channels",
        async (trx) =>
          trx
            .selectFrom("channels")
            .selectAll()
            .orderBy("priority")
            .orderBy("created_at desc")
            .execute(),
        { audit: false }
      );

      return {
        data: channels.map(sanitizeChannel)
      };
    }
  );

  app.post(
    "/channels",
    {
      schema: {
        body: createChannelBodySchema,
        response: {
          201: z.object({
            data: channelResponseSchema
          })
        }
      }
    },
    async (request, reply) => {
      const body = createChannelBodySchema.parse(request.body);

      const created = await runAdminSystemWrite(
        app.db,
        {
          action: "channel.create",
          actorId: request.platformAdmin!.userId,
          after: {
            country_code: body.country_code,
            kind: body.kind,
            mode: body.mode,
            provider_code: body.provider_code
          },
          reason: body.reason,
          targetType: "channel"
        },
        async (trx) => {
          const inserted = await trx
            .insertInto("channels")
            .values({
              capabilities: body.capabilities,
              config: toJson(body.config),
              country_code: body.country_code,
              credentials_encrypted: encryption.encrypt(body.credentials),
              health: body.health,
              id: newId("chn_"),
              kind: body.kind,
              mode: body.mode,
              network: body.network ?? null,
              priority: body.priority,
              provider_code: body.provider_code,
              status: body.status
            })
            .returningAll()
            .executeTakeFirstOrThrow();

          return inserted;
        }
      );

      return reply.status(201).send({
        data: sanitizeChannel(created)
      });
    }
  );

  app.patch(
    "/channels/:channelId",
    {
      schema: {
        body: updateChannelBodySchema,
        params: z.object({
          channelId: z.string().min(1)
        }),
        response: {
          200: z.object({
            data: channelResponseSchema
          })
        }
      }
    },
    async (request) => {
      const body = updateChannelBodySchema.parse(request.body);
      const { channelId } = z.object({
        channelId: z.string().min(1)
      }).parse(request.params);

      const updated = await runAdminSystemWrite(
        app.db,
        {
          action: "channel.update",
          actorId: request.platformAdmin!.userId,
          after: {
            channel_id: channelId
          },
          reason: body.reason,
          targetId: channelId,
          targetType: "channel"
        },
        async (trx) => {
          const before = await trx
            .selectFrom("channels")
            .selectAll()
            .where("id", "=", channelId)
            .executeTakeFirstOrThrow();

          const updated = await trx
            .updateTable("channels")
            .set({
              capabilities: body.capabilities ?? before.capabilities,
              config: body.config ? toJson(body.config) : before.config,
              country_code: body.country_code ?? before.country_code,
              credentials_encrypted: body.credentials
                ? encryption.encrypt(body.credentials)
                : before.credentials_encrypted,
              health: body.health ?? before.health,
              network:
                body.network === undefined
                  ? before.network
                  : body.network,
              priority: body.priority ?? before.priority,
              provider_code: body.provider_code ?? before.provider_code,
              status: body.status ?? before.status
            })
            .where("id", "=", channelId)
            .returningAll()
            .executeTakeFirstOrThrow();

          return updated;
        }
      );

      return {
        data: sanitizeChannel(updated)
      };
    }
  );

  app.post(
    "/channels/:channelId/status",
    {
      schema: {
        body: setChannelStatusBodySchema,
        params: z.object({
          channelId: z.string().min(1)
        }),
        response: {
          200: z.object({
            data: channelResponseSchema
          })
        }
      }
    },
    async (request) => {
      const body = setChannelStatusBodySchema.parse(request.body);
      const { channelId } = z.object({
        channelId: z.string().min(1)
      }).parse(request.params);

      const updated = await runAdminSystemWrite(
        app.db,
        {
          action: "channel.set_status",
          actorId: request.platformAdmin!.userId,
          after: {
            channel_id: channelId,
            status: body.status
          },
          reason: body.reason,
          targetId: channelId,
          targetType: "channel"
        },
        async (trx) =>
          trx
            .updateTable("channels")
            .set({
              status: body.status
            })
            .where("id", "=", channelId)
            .returningAll()
            .executeTakeFirstOrThrow()
      );

      return {
        data: sanitizeChannel(updated)
      };
    }
  );

  app.post(
    "/routing-rules",
    {
      schema: {
        body: reorderRoutingRuleBodySchema,
        response: {
          200: z.object({
            data: z.object({
              capability: z.enum(channelCapabilities),
              channel_ids: z.array(z.string()),
              country_code: z.string(),
              kind: z.enum(channelKinds),
              network: z.string().nullable()
            })
          })
        }
      }
    },
    async (request) => {
      const body = reorderRoutingRuleBodySchema.parse(request.body);

      const updated = await runAdminSystemWrite(
        app.db,
        {
          action: "routing_rule.reorder",
          actorId: request.platformAdmin!.userId,
          after: {
            capability: body.capability,
            channel_ids: body.channel_ids,
            country_code: body.country_code,
            kind: body.kind,
            network: body.network ?? null
          },
          reason: body.reason,
          targetType: "routing_rule"
        },
        async (trx) => {
          let existingQuery = trx
            .selectFrom("routing_rules")
            .selectAll()
            .where("country_code", "=", body.country_code)
            .where("kind", "=", body.kind)
            .where("capability", "=", body.capability);

          existingQuery = body.network
            ? existingQuery.where("network", "=", body.network)
            : existingQuery.where("network", "is", null);

          const existing = await existingQuery.executeTakeFirst();

          if (existing) {
            let updateQuery = trx
              .updateTable("routing_rules")
              .set({
                channel_ids: body.channel_ids
              })
              .where("country_code", "=", body.country_code)
              .where("kind", "=", body.kind)
              .where("capability", "=", body.capability);

            updateQuery = body.network
              ? updateQuery.where("network", "=", body.network)
              : updateQuery.where("network", "is", null);

            return updateQuery
              .returningAll()
              .executeTakeFirstOrThrow();
          }

          return trx
            .insertInto("routing_rules")
            .values({
              capability: body.capability,
              channel_ids: body.channel_ids,
              country_code: body.country_code,
              id: newId("rtr_"),
              kind: body.kind,
              network: body.network ?? null
            })
            .returningAll()
            .executeTakeFirstOrThrow();
        }
      );

      return {
        data: {
          capability: updated.capability,
          channel_ids: updated.channel_ids,
          country_code: updated.country_code,
          kind: updated.kind,
          network: updated.network
        }
      };
    }
  );

  app.get(
    "/routing-rules",
    {
      schema: {
        response: {
          200: z.object({
            data: z.array(
              z.object({
                capability: z.enum(channelCapabilities),
                channel_ids: z.array(z.string()),
                country_code: z.string(),
                id: z.string(),
                kind: z.enum(channelKinds),
                network: z.string().nullable()
              })
            )
          })
        }
      }
    },
    async () => {
      const rows = await runWithSystemScope(
        app.db,
        "list routing rules",
        async (trx) =>
          trx
            .selectFrom("routing_rules")
            .selectAll()
            .orderBy("country_code")
            .orderBy("kind")
            .orderBy("capability")
            .execute(),
        { audit: false }
      );

      return {
        data: rows.map((row) => ({
          capability: row.capability,
          channel_ids: row.channel_ids,
          country_code: row.country_code,
          id: row.id,
          kind: row.kind,
          network: row.network
        }))
      };
    }
  );

  app.get(
    "/msisdn-prefixes",
    {
      schema: {
        response: {
          200: z.object({
            data: z.array(
              z.object({
                country_code: z.string(),
                network: z.string(),
                prefix: z.string(),
                updated_at: z.string()
              })
            )
          })
        }
      }
    },
    async () => {
      const prefixes = await runWithSystemScope(
        app.db,
        "list msisdn prefixes",
        async (trx) =>
          trx
            .selectFrom("msisdn_prefixes")
            .selectAll()
            .orderBy("country_code")
            .orderBy("prefix")
            .execute(),
        { audit: false }
      );

      return {
        data: prefixes.map((prefix) => ({
          country_code: prefix.country_code,
          network: prefix.network,
          prefix: prefix.prefix,
          updated_at: prefix.updated_at.toISOString()
        }))
      };
    }
  );

  app.post(
    "/msisdn-prefixes",
    {
      schema: {
        body: upsertMsisdnPrefixBodySchema,
        response: {
          200: z.object({
            data: z.object({
              country_code: z.string(),
              network: z.string(),
              prefix: z.string(),
              updated_at: z.string()
            })
          })
        }
      }
    },
    async (request) => {
      const body = upsertMsisdnPrefixBodySchema.parse(request.body);

      const prefix = await runAdminSystemWrite(
        app.db,
        {
          action: "msisdn_prefix.upsert",
          actorId: request.platformAdmin!.userId,
          after: {
            country_code: body.country_code,
            network: body.network,
            prefix: body.prefix
          },
          reason: body.reason,
          targetId: `${body.country_code}:${body.prefix}`,
          targetType: "msisdn_prefix"
        },
        async (trx) => {
          const existing = await trx
            .selectFrom("msisdn_prefixes")
            .selectAll()
            .where("country_code", "=", body.country_code)
            .where("prefix", "=", body.prefix)
            .executeTakeFirst();

          if (existing) {
            return trx
              .updateTable("msisdn_prefixes")
              .set({
                network: body.network
              })
              .where("country_code", "=", body.country_code)
              .where("prefix", "=", body.prefix)
              .returningAll()
              .executeTakeFirstOrThrow();
          }

          return trx
            .insertInto("msisdn_prefixes")
            .values({
              country_code: body.country_code,
              network: body.network,
              prefix: body.prefix
            })
            .returningAll()
            .executeTakeFirstOrThrow();
        }
      );

      return {
        data: {
          country_code: prefix.country_code,
          network: prefix.network,
          prefix: prefix.prefix,
          updated_at: prefix.updated_at.toISOString()
        }
      };
    }
  );
}

function sanitizeChannel(channel: {
  capabilities: ChannelResponse["capabilities"];
  config: Json;
  country_code: string;
  created_at: Date;
  credentials_encrypted: string;
  health: ChannelResponse["health"];
  id: string;
  kind: ChannelResponse["kind"];
  mode: "test" | "live";
  network: string | null;
  priority: number;
  provider_code: string;
  status: ChannelResponse["status"];
  updated_at: Date;
}): ChannelResponse {
  return {
    capabilities: channel.capabilities,
    config: channel.config,
    country_code: channel.country_code,
    created_at: channel.created_at.toISOString(),
    has_credentials: channel.credentials_encrypted.length > 0,
    health: channel.health,
    id: channel.id,
    kind: channel.kind,
    mode: channel.mode,
    network: channel.network,
    priority: channel.priority,
    provider_code: channel.provider_code,
    status: channel.status,
    updated_at: channel.updated_at.toISOString()
  };
}

function toJson(value: unknown): Json {
  return value as Json;
}
