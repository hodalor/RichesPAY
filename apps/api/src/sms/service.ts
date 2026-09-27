import {
  getErrorDefinition,
  newId
} from "@richespay/shared";

import {
  runWithMerchantScope,
  runWithSystemScope,
  type AppDatabase
} from "../db";
import type { Json, RpMode } from "../db/types";
import { ApiRouteError } from "../lib/api-error";
import { ProviderCatalog } from "../providers/catalog";
import { executeWithFailover } from "../providers/failover";
import { DatabaseChannelRegistry } from "../providers/router";
import type { ChannelRecord, ProviderResult } from "../providers/types";

import type {
  MerchantNotificationRecord,
  PlatformSmsSettingsRecord,
  SenderIdApprovalRecord,
  SenderIdApprovalStatus,
  SenderIdListView,
  SenderIdOverallStatus,
  SenderIdPurpose,
  SenderIdQueueRecord,
  SenderIdRecord
} from "./types";

interface SmsTarget {
  countryCode: string;
  network: string;
}

export class SenderIdService {
  #catalog: ProviderCatalog | null;
  #database: AppDatabase;
  #registry: DatabaseChannelRegistry;

  constructor(input: {
    database: AppDatabase;
    encryptionKey?: string;
  }) {
    this.#database = input.database;
    this.#catalog = input.encryptionKey
      ? new ProviderCatalog({
          database: input.database,
          encryptionKey: input.encryptionKey
        })
      : null;
    this.#registry = new DatabaseChannelRegistry(input.database);
  }

  async listSenderIds(
    merchantId: string,
    mode: RpMode,
    notificationLimit = 10
  ): Promise<SenderIdListView> {
    return runWithMerchantScope(this.#database, merchantId, mode, async (trx) => {
      const senders = await trx
        .selectFrom("sender_ids")
        .selectAll()
        .orderBy("created_at", "desc")
        .execute();

      const approvals = senders.length
        ? await trx
            .selectFrom("sender_id_approvals")
            .selectAll()
            .where(
              "sender_id_id",
              "in",
              senders.map((sender) => sender.id)
            )
            .orderBy("created_at", "desc")
            .execute()
        : [];

      const notifications = await trx
        .selectFrom("merchant_notifications")
        .selectAll()
        .where("type", "like", "sender_id.%")
        .orderBy("created_at", "desc")
        .limit(notificationLimit)
        .execute();

      const approvalsBySender = new Map<string, SenderIdApprovalRecord[]>();
      for (const approval of approvals) {
        const parsed = mapApproval(approval);
        const current = approvalsBySender.get(parsed.senderIdId) ?? [];
        current.push(parsed);
        approvalsBySender.set(parsed.senderIdId, current);
      }

      const items = senders.map((sender) =>
        mapSenderId(sender, approvalsBySender.get(sender.id) ?? [])
      );

      return {
        items,
        notifications: notifications.map(mapNotification),
        summary: summarizeSenderIds(items)
      };
    });
  }

  async createSenderIdRequest(input: {
    authorizationLetterPath: string;
    countries: string[];
    createdBy: string;
    merchantId: string;
    mode: RpMode;
    purpose: SenderIdPurpose;
    sampleMessage: string;
    senderId: string;
  }): Promise<SenderIdRecord> {
    const normalizedSenderId = normalizeSenderIdValue(input.senderId);
    const normalizedCountries = normalizeCountryCodes(input.countries);
    const targets = await this.#loadSmsTargets(input.mode, normalizedCountries);

    if (targets.length === 0) {
      throw validationError(
        "countries",
        "No SMS routes are configured for the selected countries."
      );
    }

    return runWithMerchantScope(this.#database, input.merchantId, input.mode, async (trx) => {
      const existing = await trx
        .selectFrom("sender_ids")
        .select(["id"])
        .where("sender_id", "=", normalizedSenderId)
        .executeTakeFirst();

      if (existing) {
        throw validationError(
          "sender_id",
          "This sender ID has already been requested for this merchant and mode."
        );
      }

      const senderRow = await trx
        .insertInto("sender_ids")
        .values({
          authorization_letter: normalizeAuthorizationLetterPath(
            input.authorizationLetterPath
          ),
          created_by: input.createdBy,
          id: newId("sid_"),
          merchant_id: input.merchantId,
          mode: input.mode,
          purpose: input.purpose,
          sample_message: input.sampleMessage.trim(),
          sender_id: normalizedSenderId
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      const approvalRows = await trx
        .insertInto("sender_id_approvals")
        .values(
          targets.map((target) => ({
            country_code: target.countryCode,
            id: newId("sia_"),
            merchant_id: input.merchantId,
            mode: input.mode,
            network: target.network,
            rejection_reason: null,
            sender_id_id: senderRow.id,
            status: "pending" as const,
            updated_by: input.createdBy
          }))
        )
        .returningAll()
        .execute();

      return mapSenderId(senderRow, approvalRows.map(mapApproval));
    });
  }

  async listQueue(input: {
    countryCode?: string;
    limit: number;
    mode?: RpMode;
    network?: string;
    status?: SenderIdApprovalStatus;
  }): Promise<SenderIdQueueRecord[]> {
    return runWithSystemScope(
      this.#database,
      "list sender id review queue",
      async (trx) => {
        let query = trx
          .selectFrom("sender_id_approvals as approval")
          .innerJoin("sender_ids as sender", "sender.id", "approval.sender_id_id")
          .innerJoin("merchants as merchant", (join) =>
            join
              .onRef("merchant.id", "=", "sender.merchant_id")
              .onRef("merchant.mode", "=", "sender.mode")
          )
          .select([
            "approval.country_code as country_code",
            "approval.created_at as approval_created_at",
            "approval.id as approval_id",
            "approval.merchant_id as merchant_id",
            "approval.mode as mode",
            "approval.network as network",
            "approval.rejection_reason as rejection_reason",
            "approval.status as status",
            "approval.updated_at as updated_at",
            "approval.updated_by as updated_by",
            "sender.authorization_letter as authorization_letter",
            "sender.created_at as sender_created_at",
            "sender.id as sender_id_id",
            "sender.purpose as purpose",
            "sender.sample_message as sample_message",
            "sender.sender_id as sender_id",
            "merchant.legal_name as merchant_name"
          ])
          .orderBy("approval.updated_at", "desc")
          .limit(input.limit);

        if (input.countryCode) {
          query = query.where("approval.country_code", "=", input.countryCode);
        }

        if (input.mode) {
          query = query.where("approval.mode", "=", input.mode);
        }

        if (input.network) {
          query = query.where("approval.network", "=", input.network);
        }

        if (input.status) {
          query = query.where("approval.status", "=", input.status);
        }

        const rows = await query.execute();
        return rows.map((row) => ({
          approvalId: row.approval_id,
          authorizationLetter: row.authorization_letter,
          countryCode: row.country_code,
          createdAt: row.sender_created_at,
          merchantId: row.merchant_id,
          merchantName: row.merchant_name,
          mode: row.mode,
          network: row.network,
          overallStatus: deriveOverallStatus([row.status]),
          purpose: row.purpose,
          rejectionReason: row.rejection_reason,
          sampleMessage: row.sample_message,
          senderId: row.sender_id,
          senderIdId: row.sender_id_id,
          status: row.status,
          updatedAt: row.updated_at,
          updatedBy: row.updated_by
        }));
      },
      { audit: false }
    );
  }

  async exportSubmissionSheet(input: {
    countryCode: string;
    mode?: RpMode;
    network: string;
  }): Promise<{
    csv: string;
    fileName: string;
    rows: SenderIdQueueRecord[];
  }> {
    const rows = await this.listQueue({
      countryCode: input.countryCode,
      limit: 500,
      ...(input.mode ? { mode: input.mode } : {}),
      network: input.network
    });
    const csv = buildSenderIdCsv(rows);

    return {
      csv,
      fileName: `sender-ids-${input.countryCode.toLowerCase()}-${slugify(input.network)}.csv`,
      rows
    };
  }

  async markSubmitted(input: {
    adminUserId: string;
    approvalId: string;
    reason: string;
  }): Promise<SenderIdQueueRecord> {
    return this.#updateApprovalStatus({
      adminUserId: input.adminUserId,
      approvalId: input.approvalId,
      notificationType: "sender_id.submitted",
      reason: input.reason,
      status: "submitted"
    });
  }

  async approve(input: {
    adminUserId: string;
    approvalId: string;
    reason: string;
  }): Promise<SenderIdQueueRecord> {
    return this.#updateApprovalStatus({
      adminUserId: input.adminUserId,
      approvalId: input.approvalId,
      notificationType: "sender_id.approved",
      reason: input.reason,
      status: "approved"
    });
  }

  async reject(input: {
    adminUserId: string;
    approvalId: string;
    reason: string;
  }): Promise<SenderIdQueueRecord> {
    return this.#updateApprovalStatus({
      adminUserId: input.adminUserId,
      approvalId: input.approvalId,
      notificationType: "sender_id.rejected",
      reason: input.reason,
      status: "rejected"
    });
  }

  async getPlatformSettings(mode: RpMode): Promise<PlatformSmsSettingsRecord> {
    const row = await runWithSystemScope(
      this.#database,
      "load platform sms settings",
      async (trx) =>
        trx
          .selectFrom("platform_sms_settings")
          .selectAll()
          .where("mode", "=", mode)
          .executeTakeFirstOrThrow(),
      { audit: false }
    );

    return mapPlatformSettings(row);
  }

  async updatePlatformSettings(input: {
    adminUserId: string;
    defaultOtpSenderId: string | null;
    mode: RpMode;
  }): Promise<PlatformSmsSettingsRecord> {
    const normalized =
      input.defaultOtpSenderId === null
        ? null
        : normalizeSenderIdValue(input.defaultOtpSenderId);

    const row = await runWithSystemScope(
      this.#database,
      "update platform sms settings",
      async (trx) =>
        trx
          .updateTable("platform_sms_settings")
          .set({
            default_otp_sender_id: normalized,
            updated_by: input.adminUserId
          })
          .where("mode", "=", input.mode)
          .returningAll()
          .executeTakeFirstOrThrow(),
      { audit: false }
    );

    return mapPlatformSettings(row);
  }

  async resolveSenderId(input: {
    countryCode: string;
    merchantId: string;
    mode: RpMode;
    network?: string | null;
    preferredSenderId?: string | null;
    purpose: SenderIdPurpose;
  }): Promise<{
    senderId: string;
    source: "merchant" | "platform_default";
  }> {
    const preferredSenderId = input.preferredSenderId
      ? normalizeSenderIdValue(input.preferredSenderId)
      : null;

    const merchantSender = await runWithMerchantScope(
      this.#database,
      input.merchantId,
      input.mode,
      async (trx) => {
        let query = trx
          .selectFrom("sender_ids as sender")
          .innerJoin("sender_id_approvals as approval", "approval.sender_id_id", "sender.id")
          .select(["sender.sender_id as sender_id", "approval.network as network"])
          .where("approval.country_code", "=", input.countryCode)
          .where("approval.status", "=", "approved");

        if (preferredSenderId) {
          query = query.where("sender.sender_id", "=", preferredSenderId);
        } else {
          query = query.where("sender.purpose", "=", input.purpose);
        }

        if (input.network) {
          query = query.where((eb) =>
            eb.or([
              eb("approval.network", "=", input.network!),
              eb("approval.network", "is", null)
            ])
          );
        }

        return query
          .orderBy("sender.created_at", "asc")
          .executeTakeFirst();
      }
    );

    if (merchantSender) {
      return {
        senderId: merchantSender.sender_id,
        source: "merchant"
      };
    }

    if (preferredSenderId) {
      throw new ApiRouteError({
        code: "sender_id_unavailable",
        message: "The selected sender ID is not approved for this route.",
        statusCode: getErrorDefinition("sender_id_unavailable").status
      });
    }

    if (input.purpose === "otp") {
      const settings = await this.getPlatformSettings(input.mode);
      if (settings.defaultOtpSenderId) {
        return {
          senderId: settings.defaultOtpSenderId,
          source: "platform_default"
        };
      }
    }

    throw new ApiRouteError({
      code: "sender_id_unavailable",
      message: getErrorDefinition("sender_id_unavailable").message,
      statusCode: getErrorDefinition("sender_id_unavailable").status
    });
  }

  async dispatch(input: {
    body: string;
    countryCode: string;
    merchantId: string;
    mode: RpMode;
    network?: string | null;
    preferredSenderId?: string | null;
    purpose: SenderIdPurpose;
    reference: string;
    requestId: string;
    to: string;
  }): Promise<{
    channel: ChannelRecord;
    providerResult: ProviderResult;
    senderId: string;
    senderSource: "merchant" | "platform_default";
  }> {
    const catalog = this.#requireCatalog();
    const sender = await this.resolveSenderId({
      countryCode: input.countryCode,
      merchantId: input.merchantId,
      mode: input.mode,
      ...(input.network !== undefined ? { network: input.network } : {}),
      ...(input.preferredSenderId !== undefined
        ? { preferredSenderId: input.preferredSenderId }
        : {}),
      purpose: input.purpose
    });
    const channels = await this.#loadOrderedSmsChannels({
      countryCode: input.countryCode,
      mode: input.mode,
      ...(input.network !== undefined ? { network: input.network } : {})
    });

    if (channels.length === 0) {
      throw new ApiRouteError({
        code: "channel_unavailable",
        message: getErrorDefinition("channel_unavailable").message,
        statusCode: getErrorDefinition("channel_unavailable").status
      });
    }

    const byId = new Map(channels.map((channel) => [channel.id, channel]));

    const dispatched = await executeWithFailover({
      allowFailoverOnAnySubmitFailure: true,
      channelIds: channels.map((channel) => channel.id),
      executor: {
        execute: async (channelId) => {
          const channel = byId.get(channelId);
          if (!channel) {
            throw new Error(`SMS channel ${channelId} was not found`);
          }

          const providerResult = await catalog.resolveSmsProvider(channel).send({
            body: input.body,
            context: {
              merchantId: input.merchantId,
              mode: input.mode,
              requestId: input.requestId
            },
            reference: input.reference,
            senderId: sender.senderId,
            to: input.to
          });

          if (
            providerResult.outcome === "failed" ||
            providerResult.outcome === "unknown"
          ) {
            throw new Error(
              `SMS submit failed on ${channel.id}: ${providerResult.providerStatus ?? "unknown"}`
            );
          }

          return {
            channel,
            providerResult,
            senderId: sender.senderId,
            senderSource: sender.source
          };
        }
      }
    });

    return dispatched;
  }

  async #updateApprovalStatus(input: {
    adminUserId: string;
    approvalId: string;
    notificationType: string;
    reason: string;
    status: "approved" | "rejected" | "submitted";
  }): Promise<SenderIdQueueRecord> {
    return runWithSystemScope(
      this.#database,
      "update sender id approval status",
      async (trx) => {
        const current = await trx
          .selectFrom("sender_id_approvals as approval")
          .innerJoin("sender_ids as sender", "sender.id", "approval.sender_id_id")
          .innerJoin("merchants as merchant", (join) =>
            join
              .onRef("merchant.id", "=", "sender.merchant_id")
              .onRef("merchant.mode", "=", "sender.mode")
          )
          .select([
            "approval.country_code as country_code",
            "approval.created_at as approval_created_at",
            "approval.id as approval_id",
            "approval.merchant_id as merchant_id",
            "approval.mode as mode",
            "approval.network as network",
            "approval.rejection_reason as rejection_reason",
            "approval.status as status",
            "approval.updated_at as updated_at",
            "approval.updated_by as updated_by",
            "merchant.legal_name as merchant_name",
            "merchant.support_email as support_email",
            "sender.authorization_letter as authorization_letter",
            "sender.created_at as sender_created_at",
            "sender.id as sender_id_id",
            "sender.purpose as purpose",
            "sender.sample_message as sample_message",
            "sender.sender_id as sender_id"
          ])
          .where("approval.id", "=", input.approvalId)
          .executeTakeFirst();

        if (!current) {
          throw notFoundError("Sender ID approval not found");
        }

        const updated = await trx
          .updateTable("sender_id_approvals")
          .set({
            rejection_reason: input.status === "rejected" ? input.reason : null,
            status: input.status,
            updated_by: input.adminUserId,
            updated_at: new Date()
          })
          .where("id", "=", input.approvalId)
          .returningAll()
          .executeTakeFirstOrThrow();

        const title =
          input.status === "approved"
            ? `Sender ID approved on ${current.network}`
            : input.status === "rejected"
              ? `Sender ID rejected on ${current.network}`
              : `Sender ID submitted to ${current.network}`;
        const body =
          input.status === "approved"
            ? `${current.sender_id} is now approved for ${current.country_code} on ${current.network}.`
            : input.status === "rejected"
              ? `${current.sender_id} was rejected for ${current.country_code} on ${current.network}. Reason: ${input.reason}`
              : `${current.sender_id} has been submitted for ${current.country_code} on ${current.network}.`;

        await trx
          .insertInto("merchant_notifications")
          .values({
            body,
            data: {
              approval_id: updated.id,
              country_code: current.country_code,
              network: current.network,
              sender_id: current.sender_id,
              status: input.status
            },
            id: newId("ntf_"),
            merchant_id: current.merchant_id,
            mode: current.mode,
            title,
            type: input.notificationType
          })
          .execute();

        if (current.support_email) {
          await trx
            .insertInto("email_outbox")
            .values({
              body,
              id: newId("eml_"),
              merchant_id: current.merchant_id,
              mode: current.mode,
              recipient_email: current.support_email,
              subject: `${title} for ${current.merchant_name}`
            })
            .execute();
        }

        return {
          approvalId: updated.id,
          authorizationLetter: current.authorization_letter,
          countryCode: current.country_code,
          createdAt: current.sender_created_at,
          merchantId: current.merchant_id,
          merchantName: current.merchant_name,
          mode: current.mode,
          network: current.network,
          overallStatus: deriveOverallStatus([updated.status]),
          purpose: current.purpose,
          rejectionReason: updated.rejection_reason,
          sampleMessage: current.sample_message,
          senderId: current.sender_id,
          senderIdId: current.sender_id_id,
          status: updated.status,
          updatedAt: updated.updated_at,
          updatedBy: updated.updated_by
        };
      },
      { audit: false }
    );
  }

  async #loadSmsTargets(mode: RpMode, countryCodes: string[]): Promise<SmsTarget[]> {
    const rows = await runWithSystemScope(
      this.#database,
      "load sms targets for sender id approvals",
      async (trx) =>
        trx
          .selectFrom("channels")
          .select(["country_code", "network", "provider_code"])
          .where("kind", "=", "sms")
          .where("mode", "=", mode)
          .where("status", "=", "active")
          .where("country_code", "in", countryCodes)
          .execute(),
      { audit: false }
    );

    const targets = new Map<string, SmsTarget>();
    for (const row of rows) {
      const network = row.network ?? row.provider_code;
      const key = `${row.country_code}:${network}`;
      targets.set(key, {
        countryCode: row.country_code,
        network
      });
    }

    return [...targets.values()].sort((left, right) =>
      `${left.countryCode}:${left.network}`.localeCompare(
        `${right.countryCode}:${right.network}`
      )
    );
  }

  async #loadOrderedSmsChannels(input: {
    countryCode: string;
    mode: RpMode;
    network?: string | null;
  }): Promise<ChannelRecord[]> {
    if (input.mode === "test") {
      const simulator = await this.#registry.getSimulatorChannel({
        capability: "sms",
        kind: "sms"
      });
      return simulator ? [simulator] : [];
    }

    const candidates = await this.#registry.listChannels({
      countryCode: input.countryCode,
      kind: "sms",
      mode: input.mode,
      ...(input.network !== undefined ? { network: input.network } : {})
    });
    const eligible = candidates.filter(
      (channel) =>
        channel.status === "active" &&
        channel.health === "healthy" &&
        channel.capabilities.includes("sms")
    );
    const rule = await this.#registry.loadRoutingRule({
      capability: "sms",
      countryCode: input.countryCode,
      kind: "sms",
      ...(input.network !== undefined ? { network: input.network } : {})
    });

    if (!rule) {
      return [...eligible].sort((left, right) => left.priority - right.priority);
    }

    const byId = new Map(eligible.map((channel) => [channel.id, channel]));
    const ordered: ChannelRecord[] = [];

    for (const channelId of rule.channelIds) {
      const match = byId.get(channelId);
      if (match) {
        ordered.push(match);
        byId.delete(channelId);
      }
    }

    const remaining = [...byId.values()].sort((left, right) => left.priority - right.priority);
    return [...ordered, ...remaining];
  }

  #requireCatalog() {
    if (!this.#catalog) {
      throw new Error("SMS provider catalog requires an encryption key");
    }

    return this.#catalog;
  }
}

function mapApproval(row: {
  country_code: string;
  created_at: Date;
  id: string;
  merchant_id: string;
  mode: RpMode;
  network: string;
  rejection_reason: string | null;
  sender_id_id: string;
  status: SenderIdApprovalStatus;
  updated_at: Date;
  updated_by: string;
}): SenderIdApprovalRecord {
  return {
    countryCode: row.country_code,
    createdAt: row.created_at,
    id: row.id,
    merchantId: row.merchant_id,
    mode: row.mode,
    network: row.network,
    rejectionReason: row.rejection_reason,
    senderIdId: row.sender_id_id,
    status: row.status,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by
  };
}

function mapSenderId(
  row: {
    authorization_letter: string;
    created_at: Date;
    created_by: string;
    id: string;
    merchant_id: string;
    mode: RpMode;
    purpose: SenderIdPurpose;
    sample_message: string;
    sender_id: string;
  },
  approvals: SenderIdApprovalRecord[]
): SenderIdRecord {
  return {
    approvals,
    authorizationLetter: row.authorization_letter,
    createdAt: row.created_at,
    createdBy: row.created_by,
    id: row.id,
    merchantId: row.merchant_id,
    mode: row.mode,
    overallStatus: deriveOverallStatus(approvals.map((approval) => approval.status)),
    purpose: row.purpose,
    sampleMessage: row.sample_message,
    senderId: row.sender_id
  };
}

function mapNotification(row: {
  body: string;
  created_at: Date;
  data: Json;
  id: string;
  merchant_id: string;
  mode: RpMode;
  read_at: Date | null;
  title: string;
  type: string;
}): MerchantNotificationRecord {
  return {
    body: row.body,
    createdAt: row.created_at,
    data: row.data,
    id: row.id,
    merchantId: row.merchant_id,
    mode: row.mode,
    readAt: row.read_at,
    title: row.title,
    type: row.type
  };
}

function mapPlatformSettings(row: {
  created_at: Date;
  default_otp_sender_id: string | null;
  mode: RpMode;
  updated_at: Date;
  updated_by: string;
}): PlatformSmsSettingsRecord {
  return {
    createdAt: row.created_at,
    defaultOtpSenderId: row.default_otp_sender_id,
    mode: row.mode,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by
  };
}

function summarizeSenderIds(items: SenderIdRecord[]) {
  return items.reduce(
    (summary, item) => {
      summary[item.overallStatus] += 1;
      return summary;
    },
    {
      approved: 0,
      pending: 0,
      rejected: 0
    }
  );
}

function deriveOverallStatus(
  statuses: Array<SenderIdApprovalStatus>
): SenderIdOverallStatus {
  if (statuses.includes("approved")) {
    return "approved";
  }

  if (statuses.includes("pending") || statuses.includes("submitted")) {
    return "pending";
  }

  return "rejected";
}

function buildSenderIdCsv(rows: SenderIdQueueRecord[]) {
  const header = [
    "merchant_id",
    "merchant_name",
    "sender_id",
    "purpose",
    "country_code",
    "network",
    "status",
    "sample_message",
    "authorization_letter"
  ];

  const body = rows.map((row) =>
    [
      row.merchantId,
      row.merchantName,
      row.senderId,
      row.purpose,
      row.countryCode,
      row.network,
      row.status,
      row.sampleMessage,
      row.authorizationLetter
    ]
      .map(csvCell)
      .join(",")
  );

  return [header.join(","), ...body].join("\n");
}

function csvCell(value: string) {
  return `"${value.replace(/"/g, '""')}"`;
}

function normalizeSenderIdValue(value: string) {
  const normalized = value.trim().toUpperCase();
  if (!/^[A-Z0-9]{3,11}$/.test(normalized)) {
    throw validationError(
      "sender_id",
      "Sender IDs must be 3 to 11 uppercase alphanumeric characters."
    );
  }

  return normalized;
}

function normalizeCountryCodes(values: string[]) {
  const normalized = [...new Set(values.map((value) => value.trim().toUpperCase()))].filter(
    Boolean
  );

  if (normalized.length === 0) {
    throw validationError("countries", "Select at least one country.");
  }

  return normalized;
}

function normalizeAuthorizationLetterPath(value: string) {
  const normalized = value.trim();
  if (!normalized.startsWith("private/")) {
    throw validationError(
      "authorization_letter_path",
      "Authorization letters must be stored under a private path."
    );
  }

  return normalized;
}

function validationError(field: string, message: string) {
  return new ApiRouteError({
    code: "validation_error",
    field,
    message,
    statusCode: getErrorDefinition("validation_error").status
  });
}

function notFoundError(message: string) {
  return new ApiRouteError({
    code: "not_found",
    message,
    statusCode: getErrorDefinition("not_found").status
  });
}

function slugify(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}
