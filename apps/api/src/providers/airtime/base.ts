import { createHmac, timingSafeEqual } from "node:crypto";

import ipaddr from "ipaddr.js";
import { z } from "zod";

import type { ErrorCode } from "@richespay/shared";

import type { Json } from "../../db/types";
import { classifyNetworkFailure } from "../circuit-breaker";
import { mapProviderResult, type ProviderStatusMapping } from "../mobile-money/mapping";
import { OAuthTokenCache, type OAuthTokenPayload } from "../mobile-money/oauth";
import {
  airtimeNotSentStatus,
  type AirtimeFloatBalance,
  type AirtimeNetworkOffer,
  type AirtimeProvider,
  type AirtimeSendRequest,
  type NormalizedEvent,
  type ProviderCallbackVerificationInput,
  type ProviderHttpTransport,
  type ProviderResult
} from "../types";

export const airtimeAdapterConfigSchema = z.object({
  balance_path: z.string().min(1),
  base_url: z.string().url(),
  callback_ip_allowlist: z.array(z.string()).optional(),
  callback_secret: z.string().optional(),
  health_path: z.string().min(1),
  networks: z
    .array(
      z.object({
        country_code: z.string().length(2),
        currency: z.string().length(3),
        fixed_denominations: z.array(z.number().int().positive()).optional(),
        max_minor: z.number().int().positive().optional(),
        min_minor: z.number().int().positive().optional(),
        network: z.string().min(1)
      })
    )
    .optional(),
  send_path: z.string().min(1),
  status_path: z.string().min(1),
  timeout_ms: z.number().int().positive().optional(),
  token_path: z.string().min(1),
  token_scope: z.string().optional()
});

export const airtimeAdapterCredentialsSchema = z.object({
  api_key: z.string().optional(),
  callback_secret: z.string().optional(),
  client_id: z.string().min(1),
  client_secret: z.string().min(1),
  subscription_key: z.string().optional()
});

export type AirtimeAdapterConfig = z.infer<typeof airtimeAdapterConfigSchema>;
export type AirtimeAdapterCredentials = z.infer<typeof airtimeAdapterCredentialsSchema>;

export const defaultAirtimeStatusMap: Record<string, ProviderStatusMapping> = {
  ACCEPTED: { outcome: "accepted" },
  COMPLETED: { outcome: "succeeded" },
  FAILED: { failureCode: "provider_error", outcome: "failed" },
  PENDING: { outcome: "accepted" },
  PROCESSING: { outcome: "accepted" },
  REJECTED: { failureCode: "provider_error", outcome: "failed" },
  SUCCESS: { outcome: "succeeded" },
  SUCCESSFUL: { outcome: "succeeded" }
};

export const defaultAirtimeErrorMap: Record<string, ErrorCode> = {
  AIRTIME_UNAVAILABLE: "airtime_unavailable",
  AMOUNT_NOT_ALLOWED: "amount_not_allowed",
  INSUFFICIENT_FLOAT: "airtime_unavailable",
  INVALID_MSISDN: "invalid_phone_number",
  INVALID_PHONE_NUMBER: "invalid_phone_number",
  NETWORK_NOT_SUPPORTED: "network_not_supported",
  OUT_OF_STOCK: "airtime_unavailable"
};

const providerResponseSchema = z.object({
  error_code: z.string().optional(),
  event_id: z.string().optional(),
  event_type: z.string().optional(),
  provider_ref: z.string().optional(),
  reason: z.string().optional(),
  resource_id: z.string().optional(),
  resource_type: z.string().optional(),
  status: z.string(),
  to_status: z.string().optional()
});

const balanceResponseSchema = z.object({
  balance: z.number().int(),
  currency: z.string().length(3).optional()
});

export interface AirtimeAdapterInput {
  channelId: string;
  config: AirtimeAdapterConfig;
  countryCode: string;
  credentials: AirtimeAdapterCredentials;
  errorMap?: Record<string, ErrorCode>;
  providerCode: string;
  signatureHeader?: string;
  statusMap?: Record<string, ProviderStatusMapping>;
  tokenCache?: OAuthTokenCache;
  transport: ProviderHttpTransport;
}

/**
 * Shared HTTP flow for airtime vending endpoints. Each MNO adapter supplies its
 * own config schema, signature header and status/error maps.
 */
export class HttpAirtimeAdapter implements AirtimeProvider {
  #channelId: string;
  #config: AirtimeAdapterConfig;
  #countryCode: string;
  #credentials: AirtimeAdapterCredentials;
  #errorMap: Record<string, ErrorCode>;
  #providerCode: string;
  #signatureHeader: string;
  #statusMap: Record<string, ProviderStatusMapping>;
  #tokenCache: OAuthTokenCache;
  #transport: ProviderHttpTransport;

  constructor(input: AirtimeAdapterInput) {
    this.#channelId = input.channelId;
    this.#config = input.config;
    this.#countryCode = input.countryCode;
    this.#credentials = input.credentials;
    this.#errorMap = input.errorMap ?? defaultAirtimeErrorMap;
    this.#providerCode = input.providerCode;
    this.#signatureHeader = input.signatureHeader ?? "x-provider-signature";
    this.#statusMap = input.statusMap ?? defaultAirtimeStatusMap;
    this.#tokenCache = input.tokenCache ?? new OAuthTokenCache();
    this.#transport = input.transport;
  }

  async listNetworks(countryCode: string): Promise<AirtimeNetworkOffer[]> {
    return (this.#config.networks ?? [])
      .filter((entry) => entry.country_code.toUpperCase() === countryCode.toUpperCase())
      .map((entry) => ({
        currency: entry.currency.toUpperCase(),
        fixedDenominations: entry.fixed_denominations ?? null,
        maxMinor: entry.max_minor ?? null,
        minMinor: entry.min_minor ?? null,
        network: entry.network.toUpperCase()
      }));
  }

  async sendAirtime(req: AirtimeSendRequest): Promise<ProviderResult> {
    let accessToken: string;
    try {
      accessToken = await this.#loadAccessToken();
    } catch (error) {
      // The vend request was never issued, so another channel may be tried.
      return notSent(error);
    }

    try {
      const response = await this.#transport.request({
        body: {
          amount: req.amount,
          country_code: this.#countryCode,
          currency: req.currency,
          metadata: req.metadata ?? null,
          msisdn: req.msisdn,
          network: req.network,
          reference: req.reference
        },
        channelId: this.#channelId,
        headers: this.#headers(accessToken, req.context.idempotencyKey ?? req.reference),
        method: "POST",
        ...(this.#config.timeout_ms ? { timeoutMs: this.#config.timeout_ms } : {}),
        url: `${this.#config.base_url}${this.#config.send_path}`
      });

      return this.#mapResponse(response.body);
    } catch (error) {
      return classifyNetworkFailure(error) === "before_send"
        ? notSent(error)
        : unknownOutcome(error);
    }
  }

  async getStatus(providerRef: string): Promise<ProviderResult> {
    try {
      const response = await this.#authorizedGet(
        this.#config.status_path.replace("{provider_ref}", encodeURIComponent(providerRef))
      );
      return this.#mapResponse(response.body);
    } catch (error) {
      return unknownOutcome(error);
    }
  }

  async getFloatBalance(): Promise<AirtimeFloatBalance> {
    try {
      const response = await this.#authorizedGet(this.#config.balance_path);
      const parsed = balanceResponseSchema.parse(JSON.parse(response.body));
      return {
        balanceMinor: parsed.balance,
        currency: parsed.currency?.toUpperCase() ?? null,
        rawRedacted: parsed as Json
      };
    } catch (error) {
      return {
        balanceMinor: null,
        currency: null,
        rawRedacted: { error_code: errorCode(error) ?? "UNKNOWN" }
      };
    }
  }

  async healthCheck(): Promise<ProviderResult> {
    try {
      const response = await this.#authorizedGet(this.#config.health_path);
      return this.#mapResponse(response.body);
    } catch (error) {
      return {
        failureCode: "provider_error",
        outcome: "failed",
        providerStatus: "health_check_failed",
        rawRedacted: { error_code: errorCode(error) ?? "UNKNOWN" }
      };
    }
  }

  parseCallback(rawBody: string): NormalizedEvent {
    const parsed = providerResponseSchema.parse(JSON.parse(rawBody));

    return {
      ...(parsed.event_id ? { eventId: parsed.event_id } : {}),
      eventType: parsed.event_type ?? "airtime.callback",
      ...(parsed.provider_ref ? { providerRef: parsed.provider_ref } : {}),
      rawRedacted: parsed as Json,
      ...(parsed.reason ? { reason: parsed.reason } : {}),
      ...(parsed.resource_id ? { resourceId: parsed.resource_id } : {}),
      resourceType: parsed.resource_type ?? "airtime",
      toStatus: parsed.to_status ?? parsed.status
    };
  }

  verifyCallback(input: ProviderCallbackVerificationInput): boolean {
    const callbackSecret = this.#credentials.callback_secret ?? this.#config.callback_secret;

    if (this.#config.callback_ip_allowlist?.length) {
      const clientIp = ipaddr.parse(input.ip);
      const allowed = this.#config.callback_ip_allowlist.some((entry) => {
        const [range, prefixLength] = ipaddr.parseCIDR(entry);
        return clientIp.kind() === range.kind() && clientIp.match([range, prefixLength]);
      });

      if (!allowed) {
        return false;
      }
    }

    if (!callbackSecret) {
      return true;
    }

    const provided = input.headers[this.#signatureHeader];
    const signature = Array.isArray(provided) ? provided[0] : provided;
    if (!signature) {
      return false;
    }

    const expected = createHmac("sha256", callbackSecret).update(input.rawBody).digest("hex");
    const left = Buffer.from(expected, "utf8");
    const right = Buffer.from(signature, "utf8");
    return left.length === right.length && timingSafeEqual(left, right);
  }

  async #authorizedGet(path: string) {
    const accessToken = await this.#loadAccessToken();
    return this.#transport.request({
      channelId: this.#channelId,
      headers: this.#headers(accessToken),
      method: "GET",
      retrySafeReads: true,
      ...(this.#config.timeout_ms ? { timeoutMs: this.#config.timeout_ms } : {}),
      url: `${this.#config.base_url}${path}`
    });
  }

  #headers(accessToken: string, idempotencyKey?: string): Record<string, string> {
    return {
      authorization: `Bearer ${accessToken}`,
      ...(this.#credentials.api_key ? { "x-api-key": this.#credentials.api_key } : {}),
      ...(this.#credentials.subscription_key
        ? { "x-subscription-key": this.#credentials.subscription_key }
        : {}),
      ...(idempotencyKey ? { "x-idempotency-key": idempotencyKey } : {}),
      "x-provider-code": this.#providerCode
    };
  }

  async #loadAccessToken(): Promise<string> {
    return this.#tokenCache.getToken(this.#channelId, async () => {
      const response = await this.#transport.request({
        body: {
          client_id: this.#credentials.client_id,
          client_secret: this.#credentials.client_secret,
          scope: this.#config.token_scope ?? null
        },
        channelId: this.#channelId,
        headers: { "x-provider-code": this.#providerCode },
        method: "POST",
        ...(this.#config.timeout_ms ? { timeoutMs: this.#config.timeout_ms } : {}),
        url: `${this.#config.base_url}${this.#config.token_path}`
      });

      return JSON.parse(response.body) as OAuthTokenPayload;
    });
  }

  #mapResponse(body: string): ProviderResult {
    let parsed: z.infer<typeof providerResponseSchema>;
    try {
      parsed = providerResponseSchema.parse(JSON.parse(body));
    } catch {
      return {
        outcome: "unknown",
        providerStatus: "unparseable_response",
        rawRedacted: null
      };
    }

    return mapProviderResult({
      errorCode: parsed.error_code ?? null,
      errorMap: this.#errorMap,
      providerRef: parsed.provider_ref ?? null,
      rawRedacted: parsed as Json,
      status: parsed.status,
      statusMap: this.#statusMap
    });
  }
}

function errorCode(error: unknown): string | null {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : null;
}

function notSent(error: unknown): ProviderResult {
  return {
    failureCode: "airtime_unavailable",
    outcome: "failed",
    providerStatus: airtimeNotSentStatus,
    rawRedacted: { error_code: errorCode(error) ?? "UNKNOWN" }
  };
}

function unknownOutcome(error: unknown): ProviderResult {
  return {
    outcome: "unknown",
    providerStatus: "unknown",
    rawRedacted: { error_code: errorCode(error) ?? "UNKNOWN" }
  };
}

export interface AirtimeChannelAdapterInput {
  channelId: string;
  config: unknown;
  countryCode: string;
  credentials: unknown;
  transport: ProviderHttpTransport;
}

export function buildAirtimeAdapterInput(
  input: AirtimeChannelAdapterInput & {
    configSchema?: typeof airtimeAdapterConfigSchema;
    errorMap?: Record<string, ErrorCode>;
    providerCode: string;
    signatureHeader: string;
  }
): AirtimeAdapterInput {
  return {
    channelId: input.channelId,
    config: (input.configSchema ?? airtimeAdapterConfigSchema).parse(input.config),
    countryCode: input.countryCode,
    credentials: airtimeAdapterCredentialsSchema.parse(input.credentials),
    errorMap: { ...defaultAirtimeErrorMap, ...(input.errorMap ?? {}) },
    providerCode: input.providerCode,
    signatureHeader: input.signatureHeader,
    transport: input.transport
  };
}
