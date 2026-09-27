import type {
  NormalizedEvent,
  ProviderHttpTransport,
  ProviderResult,
  SmsMessageRequest,
  SmsProvider
} from "./types";

interface HttpSmsProviderInput {
  channelId: string;
  config: unknown;
  credentials: unknown;
  transport: ProviderHttpTransport;
}

interface HttpSmsConfig {
  balance_url?: string;
  body_field?: string;
  callback?: {
    error_field?: string;
    event_type?: string;
    provider_ref_field?: string;
    rejected_values?: string[];
    resource_id_field?: string;
    status_field?: string;
    to_status?: Record<string, string>;
    undelivered_values?: string[];
  };
  health_url?: string;
  reference_field?: string;
  sender_id_field?: string;
  status_field?: string;
  submit_method?: "POST" | "PUT";
  submit_url?: string;
  success_values?: string[];
  to_field?: string;
  provider_ref_field?: string;
}

// TODO(spec): tighten this adapter once a concrete HTTP SMS provider spec is
// added under docs/providers/. For now the contract is config-driven and keeps
// the field mapping explicit inside channel config.
export class HttpSmsProvider implements SmsProvider {
  #channelId: string;
  #config: HttpSmsConfig;
  #credentials: Record<string, unknown>;
  #transport: ProviderHttpTransport;

  constructor(input: HttpSmsProviderInput) {
    this.#channelId = input.channelId;
    this.#config = normalizeHttpSmsConfig(input.config);
    this.#credentials =
      input.credentials && typeof input.credentials === "object" && !Array.isArray(input.credentials)
        ? (input.credentials as Record<string, unknown>)
        : {};
    this.#transport = input.transport;
  }

  async send(msg: SmsMessageRequest): Promise<ProviderResult> {
    if (!this.#config.submit_url) {
      return {
        failureCode: "provider_error",
        outcome: "failed",
        providerStatus: "not_configured",
        rawRedacted: {
          provider_code: "sms_http",
          todo_spec: true
        }
      };
    }

    const payload: Record<string, unknown> = {
      [this.#config.body_field ?? "message"]: msg.body,
      [this.#config.reference_field ?? "reference"]: msg.reference,
      [this.#config.sender_id_field ?? "sender_id"]: msg.senderId,
      [this.#config.to_field ?? "to"]: msg.to
    };

    const response = await this.#transport.request({
      body: payload,
      channelId: this.#channelId,
      headers: buildAuthHeaders(this.#credentials),
      method: this.#config.submit_method ?? "POST",
      timeoutMs: 10_000,
      url: this.#config.submit_url
    });

    const parsedBody = tryParseJson(response.body);
    const providerRef = pickString(parsedBody, this.#config.provider_ref_field ?? "provider_ref");
    const providerStatus =
      pickString(parsedBody, this.#config.status_field ?? "status") ??
      (response.statusCode >= 200 && response.statusCode < 300 ? "accepted" : "failed");
    const successValues = this.#config.success_values ?? ["accepted", "queued", "submitted"];

    return {
      outcome:
        response.statusCode >= 200 &&
        response.statusCode < 300 &&
        successValues.includes(providerStatus.toLowerCase())
          ? "accepted"
          : "failed",
      ...(providerRef ? { providerRef } : {}),
      providerStatus,
      ...(response.statusCode >= 200 && response.statusCode < 300
        ? {}
        : { failureCode: "provider_error" }),
      rawRedacted: {
        provider_code: "sms_http",
        response_body: (parsedBody ?? response.body) as ProviderResult["rawRedacted"],
        status_code: response.statusCode,
        todo_spec: true
      }
    };
  }

  async parseDeliveryReport(rawBody: string): Promise<NormalizedEvent> {
    const parsed = tryParseJson(rawBody);
    if (!parsed) {
      return {
        eventType: "sms.delivery_report",
        rawRedacted: {
          raw_body: "[UNPARSEABLE]"
        }
      };
    }

    const callback = this.#config.callback ?? {};
    const status =
      pickString(parsed, callback.status_field ?? "status")?.toLowerCase() ?? "unknown";
    const providerRef = pickString(parsed, callback.provider_ref_field ?? "provider_ref");
    const error = pickString(parsed, callback.error_field ?? "error");
    const resourceId = pickString(parsed, callback.resource_id_field ?? "resource_id");
    const explicitStatus = callback.to_status?.[status];
    const toStatus =
      explicitStatus ??
      (callback.undelivered_values?.map((value) => value.toLowerCase()).includes(status)
        ? "undelivered"
        : callback.rejected_values?.map((value) => value.toLowerCase()).includes(status)
          ? "failed"
          : "delivered");

    return {
      eventType: callback.event_type ?? "sms.delivery_report",
      ...(providerRef ? { providerRef } : {}),
      rawRedacted: parsed as NormalizedEvent["rawRedacted"],
      ...(error ? { reason: error } : {}),
      ...(resourceId ? { resourceId, resourceType: "sms" as const } : {}),
      toStatus
    };
  }

  async getBalance(): Promise<ProviderResult> {
    if (!this.#config.balance_url) {
      return {
        outcome: "unknown",
        providerRef: "sms_http_balance",
        providerStatus: "not_configured",
        rawRedacted: {
          provider_code: "sms_http",
          todo_spec: true
        }
      };
    }

    const response = await this.#transport.request({
      channelId: this.#channelId,
      headers: buildAuthHeaders(this.#credentials),
      method: "GET",
      retrySafeReads: true,
      timeoutMs: 10_000,
      url: this.#config.balance_url
    });

    return {
      outcome: response.statusCode >= 200 && response.statusCode < 300 ? "succeeded" : "failed",
      providerRef: "sms_http_balance",
      providerStatus: String(response.statusCode),
      ...(response.statusCode >= 200 && response.statusCode < 300
        ? {}
        : { failureCode: "provider_error" }),
      rawRedacted: {
        provider_code: "sms_http",
        response_body: (tryParseJson(response.body) ?? response.body) as ProviderResult["rawRedacted"],
        status_code: response.statusCode,
        todo_spec: true
      }
    };
  }

  async healthCheck(): Promise<ProviderResult> {
    if (!this.#config.health_url) {
      return {
        outcome: "unknown",
        providerRef: "sms_http",
        providerStatus: "not_configured",
        rawRedacted: {
          provider_code: "sms_http",
          todo_spec: true
        }
      };
    }

    const response = await this.#transport.request({
      channelId: this.#channelId,
      headers: buildAuthHeaders(this.#credentials),
      method: "GET",
      retrySafeReads: true,
      timeoutMs: 10_000,
      url: this.#config.health_url
    });

    return {
      outcome: response.statusCode >= 200 && response.statusCode < 300 ? "succeeded" : "failed",
      providerRef: "sms_http",
      providerStatus: String(response.statusCode),
      ...(response.statusCode >= 200 && response.statusCode < 300
        ? {}
        : { failureCode: "provider_error" }),
      rawRedacted: {
        provider_code: "sms_http",
        status_code: response.statusCode,
        todo_spec: true
      }
    };
  }
}

function buildAuthHeaders(credentials: Record<string, unknown>) {
  const headers: Record<string, string> = {};

  if (typeof credentials.api_key === "string" && credentials.api_key.length > 0) {
    headers.authorization = `Bearer ${credentials.api_key}`;
  }

  if (
    typeof credentials.username === "string" &&
    typeof credentials.password === "string"
  ) {
    headers.authorization = `Basic ${Buffer.from(
      `${credentials.username}:${credentials.password}`,
      "utf8"
    ).toString("base64")}`;
  }

  if (
    typeof credentials.header_name === "string" &&
    typeof credentials.header_value === "string"
  ) {
    headers[credentials.header_name] = credentials.header_value;
  }

  return headers;
}

function normalizeHttpSmsConfig(config: unknown): HttpSmsConfig {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return {};
  }

  return config as HttpSmsConfig;
}

function pickString(
  value: Record<string, unknown> | null,
  field: string
): string | undefined {
  if (!value) {
    return undefined;
  }

  const segments = field.split(".");
  let current: unknown = value;

  for (const segment of segments) {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }

    current = (current as Record<string, unknown>)[segment];
  }

  return typeof current === "string" && current.trim() !== "" ? current : undefined;
}

function tryParseJson(rawBody: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(rawBody) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }

    return null;
  } catch {
    return null;
  }
}
