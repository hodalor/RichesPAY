import { z } from "zod";

import { runAdminSystemWrite } from "../auth/admin-access";
import type { FastifyTypedInstance } from "../types";

import { SenderIdService } from "./service";
import {
  senderIdApprovalStatuses,
  senderIdOverallStatuses,
  senderIdPurposes,
  type PlatformSmsSettingsRecord,
  type SenderIdQueueRecord
} from "./types";

const senderIdQueueResponseSchema = z.object({
  approval_id: z.string(),
  authorization_letter: z.string(),
  country_code: z.string(),
  created_at: z.string().datetime(),
  merchant_id: z.string(),
  merchant_name: z.string(),
  mode: z.enum(["test", "live"]),
  network: z.string(),
  overall_status: z.enum(senderIdOverallStatuses),
  purpose: z.enum(senderIdPurposes),
  rejection_reason: z.string().nullable(),
  sample_message: z.string(),
  sender_id: z.string(),
  sender_id_id: z.string(),
  status: z.enum(senderIdApprovalStatuses),
  updated_at: z.string().datetime(),
  updated_by: z.string()
});

const platformSettingsResponseSchema = z.object({
  created_at: z.string().datetime(),
  default_otp_sender_id: z.string().nullable(),
  mode: z.enum(["test", "live"]),
  updated_at: z.string().datetime(),
  updated_by: z.string()
});

const approvalActionBodySchema = z.object({
  reason: z.string().min(1)
});

export async function registerSmsAdminRoutes(app: FastifyTypedInstance) {
  const senderIdService = new SenderIdService({
    database: app.db
  });

  app.get(
    "/sms/sender-ids/queue",
    {
      schema: {
        querystring: z.object({
          country_code: z.string().length(2).optional(),
          limit: z.coerce.number().int().positive().max(500).default(100),
          mode: z.enum(["test", "live"]).optional(),
          network: z.string().min(1).optional(),
          status: z.enum(senderIdApprovalStatuses).optional()
        }),
        response: {
          200: z.object({
            data: z.array(senderIdQueueResponseSchema)
          })
        }
      }
    },
    async (request) => {
      const rows = await senderIdService.listQueue({
        ...(request.query.country_code
          ? { countryCode: request.query.country_code.toUpperCase() }
          : {}),
        limit: request.query.limit,
        ...(request.query.mode ? { mode: request.query.mode } : {}),
        ...(request.query.network ? { network: request.query.network } : {}),
        ...(request.query.status ? { status: request.query.status } : {})
      });

      return {
        data: rows.map(serializeQueueRow)
      };
    }
  );

  app.get(
    "/sms/sender-ids/submission-sheet",
    {
      schema: {
        querystring: z.object({
          country_code: z.string().length(2),
          mode: z.enum(["test", "live"]).optional(),
          network: z.string().min(1)
        }),
        response: {
          200: z.object({
            data: z.object({
              csv: z.string(),
              file_name: z.string(),
              rows: z.array(senderIdQueueResponseSchema)
            })
          })
        }
      }
    },
    async (request) => {
      const sheet = await senderIdService.exportSubmissionSheet({
        countryCode: request.query.country_code.toUpperCase(),
        ...(request.query.mode ? { mode: request.query.mode } : {}),
        network: request.query.network
      });

      return {
        data: {
          csv: sheet.csv,
          file_name: sheet.fileName,
          rows: sheet.rows.map(serializeQueueRow)
        }
      };
    }
  );

  app.post(
    "/sms/sender-ids/:approvalId/submit",
    {
      schema: {
        body: approvalActionBodySchema,
        params: z.object({
          approvalId: z.string().min(1)
        }),
        response: {
          200: z.object({
            data: senderIdQueueResponseSchema
          })
        }
      }
    },
    async (request) => {
      const updated = await runAdminSystemWrite(
        app.db,
        {
          action: "sender_id.submitted",
          actorId: request.platformAdmin!.userId,
          ip: request.ip,
          reason: request.body.reason,
          targetId: request.params.approvalId,
          targetType: "sender_id_approval",
          userAgent: request.headers["user-agent"]?.toString() ?? null
        },
        async () =>
          senderIdService.markSubmitted({
            adminUserId: request.platformAdmin!.userId,
            approvalId: request.params.approvalId,
            reason: request.body.reason
          })
      );

      return {
        data: serializeQueueRow(updated)
      };
    }
  );

  app.post(
    "/sms/sender-ids/:approvalId/approve",
    {
      schema: {
        body: approvalActionBodySchema,
        params: z.object({
          approvalId: z.string().min(1)
        }),
        response: {
          200: z.object({
            data: senderIdQueueResponseSchema
          })
        }
      }
    },
    async (request) => {
      const updated = await runAdminSystemWrite(
        app.db,
        {
          action: "sender_id.approved",
          actorId: request.platformAdmin!.userId,
          ip: request.ip,
          reason: request.body.reason,
          targetId: request.params.approvalId,
          targetType: "sender_id_approval",
          userAgent: request.headers["user-agent"]?.toString() ?? null
        },
        async () =>
          senderIdService.approve({
            adminUserId: request.platformAdmin!.userId,
            approvalId: request.params.approvalId,
            reason: request.body.reason
          })
      );

      return {
        data: serializeQueueRow(updated)
      };
    }
  );

  app.post(
    "/sms/sender-ids/:approvalId/reject",
    {
      schema: {
        body: approvalActionBodySchema,
        params: z.object({
          approvalId: z.string().min(1)
        }),
        response: {
          200: z.object({
            data: senderIdQueueResponseSchema
          })
        }
      }
    },
    async (request) => {
      const updated = await runAdminSystemWrite(
        app.db,
        {
          action: "sender_id.rejected",
          actorId: request.platformAdmin!.userId,
          ip: request.ip,
          reason: request.body.reason,
          targetId: request.params.approvalId,
          targetType: "sender_id_approval",
          userAgent: request.headers["user-agent"]?.toString() ?? null
        },
        async () =>
          senderIdService.reject({
            adminUserId: request.platformAdmin!.userId,
            approvalId: request.params.approvalId,
            reason: request.body.reason
          })
      );

      return {
        data: serializeQueueRow(updated)
      };
    }
  );

  app.get(
    "/sms/platform-settings/:mode",
    {
      schema: {
        params: z.object({
          mode: z.enum(["test", "live"])
        }),
        response: {
          200: z.object({
            data: platformSettingsResponseSchema
          })
        }
      }
    },
    async (request) => {
      const settings = await senderIdService.getPlatformSettings(request.params.mode);

      return {
        data: serializePlatformSettings(settings)
      };
    }
  );

  app.put(
    "/sms/platform-settings/:mode",
    {
      schema: {
        body: z.object({
          default_otp_sender_id: z.string().min(3).max(11).nullable()
        }),
        params: z.object({
          mode: z.enum(["test", "live"])
        }),
        response: {
          200: z.object({
            data: platformSettingsResponseSchema
          })
        }
      }
    },
    async (request) => {
      const settings = await runAdminSystemWrite(
        app.db,
        {
          action: "platform_sms_settings.updated",
          actorId: request.platformAdmin!.userId,
          ip: request.ip,
          reason: "Update platform default OTP sender ID",
          targetId: request.params.mode,
          targetType: "platform_sms_settings",
          userAgent: request.headers["user-agent"]?.toString() ?? null
        },
        async () =>
          senderIdService.updatePlatformSettings({
            adminUserId: request.platformAdmin!.userId,
            defaultOtpSenderId: request.body.default_otp_sender_id,
            mode: request.params.mode
          })
      );

      return {
        data: serializePlatformSettings(settings)
      };
    }
  );
}

function serializeQueueRow(record: SenderIdQueueRecord) {
  return {
    approval_id: record.approvalId,
    authorization_letter: record.authorizationLetter,
    country_code: record.countryCode,
    created_at: record.createdAt.toISOString(),
    merchant_id: record.merchantId,
    merchant_name: record.merchantName,
    mode: record.mode,
    network: record.network,
    overall_status: record.overallStatus,
    purpose: record.purpose,
    rejection_reason: record.rejectionReason,
    sample_message: record.sampleMessage,
    sender_id: record.senderId,
    sender_id_id: record.senderIdId,
    status: record.status,
    updated_at: record.updatedAt.toISOString(),
    updated_by: record.updatedBy
  };
}

function serializePlatformSettings(record: PlatformSmsSettingsRecord) {
  return {
    created_at: record.createdAt.toISOString(),
    default_otp_sender_id: record.defaultOtpSenderId,
    mode: record.mode,
    updated_at: record.updatedAt.toISOString(),
    updated_by: record.updatedBy
  };
}
