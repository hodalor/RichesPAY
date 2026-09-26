import { createHmac, timingSafeEqual } from "node:crypto";

import ipaddr from "ipaddr.js";
import { z } from "zod";

import type { ErrorCode } from "@richespay/shared";

import type { Json } from "../../db/types";
import type {
  MobileMoneyCollectRequest,
  MobileMoneyPayoutRequest,
  MobileMoneyProvider,
  NormalizedEvent,
  ProviderCallbackVerificationInput,
  ProviderHttpTransport,
  ProviderResult
} from "../types";
import { mapProviderResult, type ProviderStatusMapping } from "./mapping";
import {
  InvalidMobileMoneyPhoneError,
  normalizeMobileMoneyPhoneNumber
} from "./phone";
import { OAuthTokenCache, type OAuthTokenPayload } from "./oauth";

export const placeholderMobileMoneyConfigSchema = z.object({
  base_url: z.string().url(),
  callback_ip_allowlist: z.array(z.string()).optional(),
  callback_secret: z.string().optional(),
  health_path: z.string().min(1),
  lookup_path: z.string().min(1),
  payout_path: z.string().min(1),
  request_to_pay_path: z.string().min(1),
  status_path: z.string().min(1),
  timeout_ms: z.number().int().positive().optional(),
  token_path: z.string().min(1),
  token_scope: z.string().optional()
});

export const placeholderMobileMoneyCredentialsSchema = z.object({
  api_key: z.string().optional(),
  callback_secret: z.string().optional(),
  client_id: z.string().min(1),
  client_secret: z.string().min(1),
  merchant_id: z.string().optional(),
  subscription_key: z.string().optional()
});

const providerResponseSchema = z.object({
  account_name: z.string().optional(),
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

export type PlaceholderMobileMoneyConfig = z.infer<
  typeof placeholderMobileMoneyConfigSchema
>;
export type PlaceholderMobileMoneyCredentials = z.infer<
  typeof placeholderMobileMoneyCredentialsSchema
>;

interface PlaceholderMobileMoneyAdapterInput {
  channelId: string;
  config: PlaceholderMobileMoneyConfig;
  countryCode: string;
  credentials: PlaceholderMobileMoneyCredentials;
  errorMap: Record<string, ErrorCode>;
  providerCode: string;
  signatureHeader?: string;
  statusMap: Record<string, ProviderStatusMapping>;
  tokenCache?: OAuthTokenCache;
  transport: ProviderHttpTransport;
}

export class PlaceholderMobileMoneyAdapter implements MobileMoneyProvider {
  #channelId: string;
  #config: PlaceholderMobileMoneyConfig;
  #countryCode: string;
  #credentials: PlaceholderMobileMoneyCredentials;
  #errorMap: Record<string, ErrorCode>;
  #providerCode: string;
  #signatureHeader: string;
  #statusMap: Record<string, ProviderStatusMapping>;
  #tokenCache: OAuthTokenCache;
  #transport: ProviderHttpTransport;

  constructor(input: PlaceholderMobileMoneyAdapterInput) {
    this.#channelId = input.channelId;
    this.#config = input.config;
    this.#countryCode = input.countryCode;
    this.#credentials = input.credentials;
    this.#errorMap = input.errorMap;
    this.#providerCode = input.providerCode;
    this.#signatureHeader = input.signatureHeader ?? "x-provider-signature";
    this.#statusMap = input.statusMap;
    this.#tokenCache = input.tokenCache ?? new OAuthTokenCache();
    this.#transport = input.transport;
  }

  async collect(req: MobileMoneyCollectRequest): Promise<ProviderResult> {
    const normalized = this.#normalizeNumberResult(req.msisdn);
    if ("outcome" in normalized) {
      return normalized;
    }

    try {
      const response = await this.#requestWithAccessToken({
        body: {
          amount: req.amount,
          callback_url: req.callbackUrl ?? null,
          currency: req.currency,
          merchant_id: this.#credentials.merchant_id ?? null,
          metadata: req.metadata ?? null,
          msisdn: normalized.msisdn,
          network: req.network ?? null,
          reference: req.reference
        },
        method: "POST",
        path: this.#config.request_to_pay_path
      });

      return this.#mapResponse(response.body);
    } catch (error) {
      return mapTransportError(error);
    }
  }

  async getStatus(providerRef: string): Promise<ProviderResult> {
    try {
      const response = await this.#requestWithAccessToken({
        method: "GET",
        path: this.#config.status_path.replace(
          "{provider_ref}",
          encodeURIComponent(providerRef)
        ),
        retrySafeReads: true
      });

      return this.#mapResponse(response.body);
    } catch (error) {
      return mapTransportError(error);
    }
  }

  async healthCheck(): Promise<ProviderResult> {
    try {
      const response = await this.#requestWithAccessToken({
        method: "GET",
        path: this.#config.health_path,
        retrySafeReads: true
      });

      return this.#mapResponse(response.body);
    } catch (error) {
      return mapTransportError(error);
    }
  }

  async lookupAccountName(msisdn: string): Promise<ProviderResult> {
    const normalized = this.#normalizeNumberResult(msisdn);
    if ("outcome" in normalized) {
      return normalized;
    }

    try {
      const response = await this.#requestWithAccessToken({
        method: "GET",
        path: `${this.#config.lookup_path}?msisdn=${encodeURIComponent(normalized.msisdn)}`,
        retrySafeReads: true
      });

      return this.#mapResponse(response.body);
    } catch (error) {
      return mapTransportError(error);
    }
  }

  async parseCallback(rawBody: string): Promise<NormalizedEvent> {
    const parsed = providerResponseSchema.parse(JSON.parse(rawBody));

    return {
      ...(parsed.event_id ? { eventId: parsed.event_id } : {}),
      eventType: parsed.event_type ?? "provider.callback",
      ...(parsed.provider_ref ? { providerRef: parsed.provider_ref } : {}),
      rawRedacted: parsed as Json,
      ...(parsed.reason ? { reason: parsed.reason } : {}),
      ...(parsed.resource_id ? { resourceId: parsed.resource_id } : {}),
      ...(parsed.resource_type ? { resourceType: parsed.resource_type } : {}),
      toStatus: parsed.to_status ?? parsed.status
    };
  }

  async payout(req: MobileMoneyPayoutRequest): Promise<ProviderResult> {
    const normalized = this.#normalizeNumberResult(req.msisdn);
    if ("outcome" in normalized) {
      return normalized;
    }

    try {
      const response = await this.#requestWithAccessToken({
        body: {
          amount: req.amount,
          callback_url: req.callbackUrl ?? null,
          currency: req.currency,
          merchant_id: this.#credentials.merchant_id ?? null,
          metadata: req.metadata ?? null,
          msisdn: normalized.msisdn,
          network: req.network ?? null,
          reference: req.reference
        },
        method: "POST",
        path: this.#config.payout_path
      });

      return this.#mapResponse(response.body);
    } catch (error) {
      return mapTransportError(error);
    }
  }

  verifyCallback(input: ProviderCallbackVerificationInput): boolean {
    const callbackSecret =
      this.#credentials.callback_secret ?? this.#config.callback_secret;

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

    const expected = createHmac("sha256", callbackSecret)
      .update(input.rawBody)
      .digest("hex");
    const left = Buffer.from(expected, "utf8");
    const right = Buffer.from(signature, "utf8");

    return left.length === right.length && timingSafeEqual(left, right);
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
        headers: {
          ...(this.#credentials.api_key
            ? { "x-api-key": this.#credentials.api_key }
            : {}),
          ...(this.#credentials.subscription_key
            ? { "x-subscription-key": this.#credentials.subscription_key }
            : {}),
          "x-provider-code": this.#providerCode
        },
        method: "POST",
        ...(this.#config.timeout_ms ? { timeoutMs: this.#config.timeout_ms } : {}),
        url: `${this.#config.base_url}${this.#config.token_path}`
      });

      return JSON.parse(response.body) as OAuthTokenPayload;
    });
  }

  #mapResponse(body: string): ProviderResult {
    const parsed = providerResponseSchema.parse(JSON.parse(body));

    return mapProviderResult({
      errorCode: parsed.error_code ?? null,
      errorMap: this.#errorMap,
      providerRef: parsed.provider_ref ?? null,
      rawRedacted: parsed as Json,
      status: parsed.status,
      statusMap: this.#statusMap
    });
  }

  #normalizeNumberResult(msisdn: string): { msisdn: string } | ProviderResult {
    try {
      return {
        msisdn: normalizeMobileMoneyPhoneNumber(msisdn, this.#countryCode)
      };
    } catch (error) {
      if (error instanceof InvalidMobileMoneyPhoneError) {
        return {
          failureCode: "invalid_phone_number",
          outcome: "failed",
          providerStatus: "validation_failed",
          rawRedacted: {
            error: error.message
          }
        };
      }

      throw error;
    }
  }

  async #requestWithAccessToken(input: {
    body?: Record<string, unknown>;
    method: "GET" | "POST";
    path: string;
    retrySafeReads?: boolean;
  }) {
    const accessToken = await this.#loadAccessToken();

    return this.#transport.request({
      ...(input.body ? { body: input.body } : {}),
      channelId: this.#channelId,
      headers: {
        authorization: `Bearer ${accessToken}`,
        ...(this.#credentials.api_key
          ? { "x-api-key": this.#credentials.api_key }
          : {}),
        ...(this.#credentials.subscription_key
          ? { "x-subscription-key": this.#credentials.subscription_key }
          : {}),
        "x-provider-code": this.#providerCode
      },
      method: input.method,
      ...(input.retrySafeReads ? { retrySafeReads: input.retrySafeReads } : {}),
      ...(this.#config.timeout_ms ? { timeoutMs: this.#config.timeout_ms } : {}),
      url: `${this.#config.base_url}${input.path}`
    });
  }
}

function mapTransportError(error: unknown): ProviderResult {
  const code =
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
      ? error.code
      : null;

  if (code === "ETIMEDOUT" || code === "ECONNABORTED") {
    return {
      outcome: "unknown",
      providerStatus: "timeout",
      rawRedacted: {
        error_code: code
      }
    };
  }

  return {
    failureCode: "provider_error",
    outcome: "failed",
    providerStatus: "request_failed",
    rawRedacted: {
      error_code: code ?? "UNKNOWN"
    }
  };
}
