import { z } from "zod";

import type { FastifyTypedInstance } from "../types";

import { SenderIdService } from "./service";
import {
  senderIdApprovalStatuses,
  senderIdOverallStatuses,
  senderIdPurposes,
  type MerchantNotificationRecord,
  type SenderIdApprovalRecord,
  type SenderIdRecord
} from "./types";

const senderIdApprovalResponseSchema = z.object({
  country_code: z.string(),
  created_at: z.string().datetime(),
  id: z.string(),
  network: z.string(),
  rejection_reason: z.string().nullable(),
  status: z.enum(senderIdApprovalStatuses),
  updated_at: z.string().datetime(),
  updated_by: z.string()
});

const senderIdResponseSchema = z.object({
  approvals: z.array(senderIdApprovalResponseSchema),
  authorization_letter: z.string(),
  created_at: z.string().datetime(),
  created_by: z.string(),
  id: z.string(),
  overall_status: z.enum(senderIdOverallStatuses),
  purpose: z.enum(senderIdPurposes),
  sample_message: z.string(),
  sender_id: z.string()
});

const notificationResponseSchema = z.object({
  body: z.string(),
  created_at: z.string().datetime(),
  data: z.record(z.string(), z.unknown()),
  id: z.string(),
  read_at: z.string().datetime().nullable(),
  title: z.string(),
  type: z.string()
});

export async function registerSmsDashboardRoutes(app: FastifyTypedInstance) {
  const senderIdService = new SenderIdService({
    database: app.db,
    encryptionKey: app.appEnv.ENCRYPTION_KEY
  });

  app.get(
    "/sms/sender-ids",
    {
      schema: {
        querystring: z.object({
          notification_limit: z.coerce.number().int().positive().max(50).default(10)
        }),
        response: {
          200: z.object({
            data: z.object({
              items: z.array(senderIdResponseSchema),
              notifications: z.array(notificationResponseSchema),
              summary: z.object({
                approved: z.number().int(),
                pending: z.number().int(),
                rejected: z.number().int()
              })
            })
          })
        }
      }
    },
    async (request) => {
      request.assertDashboardPermission("sms.manage");

      const view = await senderIdService.listSenderIds(
        request.dashboardMembership!.merchantId,
        request.dashboardMembership!.mode,
        request.query.notification_limit
      );

      return {
        data: {
          items: view.items.map(serializeSenderId),
          notifications: view.notifications.map(serializeNotification),
          summary: view.summary
        }
      };
    }
  );

  app.post(
    "/sms/sender-ids",
    {
      schema: {
        body: z.object({
          authorization_letter_path: z.string().min(1),
          countries: z.array(z.string().length(2)).min(1),
          purpose: z.enum(senderIdPurposes),
          sample_message: z.string().min(1).max(500),
          sender_id: z.string().min(3).max(11)
        }),
        response: {
          201: z.object({
            data: senderIdResponseSchema
          })
        }
      }
    },
    async (request, reply) => {
      request.assertDashboardPermission("sms.manage");

      const senderId = await senderIdService.createSenderIdRequest({
        authorizationLetterPath: request.body.authorization_letter_path,
        countries: request.body.countries,
        createdBy: request.dashboardMembership!.userId,
        merchantId: request.dashboardMembership!.merchantId,
        mode: request.dashboardMembership!.mode,
        purpose: request.body.purpose,
        sampleMessage: request.body.sample_message,
        senderId: request.body.sender_id
      });

      return reply.status(201).send({
        data: serializeSenderId(senderId)
      });
    }
  );
}

function serializeSenderId(record: SenderIdRecord) {
  return {
    approvals: record.approvals.map(serializeApproval),
    authorization_letter: record.authorizationLetter,
    created_at: record.createdAt.toISOString(),
    created_by: record.createdBy,
    id: record.id,
    overall_status: record.overallStatus,
    purpose: record.purpose,
    sample_message: record.sampleMessage,
    sender_id: record.senderId
  };
}

function serializeApproval(record: SenderIdApprovalRecord) {
  return {
    country_code: record.countryCode,
    created_at: record.createdAt.toISOString(),
    id: record.id,
    network: record.network,
    rejection_reason: record.rejectionReason,
    status: record.status,
    updated_at: record.updatedAt.toISOString(),
    updated_by: record.updatedBy
  };
}

function serializeNotification(record: MerchantNotificationRecord) {
  return {
    body: record.body,
    created_at: record.createdAt.toISOString(),
    data: (record.data ?? {}) as Record<string, unknown>,
    id: record.id,
    read_at: record.readAt?.toISOString() ?? null,
    title: record.title,
    type: record.type
  };
}
