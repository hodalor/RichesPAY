import type {
  NormalizedEvent,
  ProviderResult,
  SmsMessageRequest,
  SmsProvider
} from "./types";

export interface SmppSubmitSegmentInput {
  destinationAddr: string;
  partNumber: number;
  reference: string;
  shortMessage: string;
  sourceAddr: string;
  totalParts: number;
}

export interface SmppBoundSessionLike {
  bindTransceiver(): Promise<void>;
  enquireLink(): Promise<void>;
  onClose?(handler: () => void): void;
  submitSm(input: SmppSubmitSegmentInput): Promise<{ messageId: string }>;
}

export interface SmppTransportLike {
  connect(input: {
    host: string;
    password?: string;
    port: number;
    systemId?: string;
    timeoutMs: number;
  }): Promise<SmppBoundSessionLike>;
}

interface SmppSmsProviderInput {
  config: unknown;
  credentials?: unknown;
  transport?: SmppTransportLike;
}

interface SmppSmsConfig {
  auto_reconnect?: boolean;
  enquire_link_interval_ms?: number;
  host?: string;
  long_message_segment_chars?: number;
  port?: number;
  reconnect_delay_ms?: number;
  timeout_ms?: number;
  tps?: number;
}

// TODO(spec): wire this session manager to a concrete SMPP library once an
// installed provider spec exists in docs/providers/. The adapter already keeps
// throughput control, long-message concatenation, keep-alives, and reconnect
// hooks inside one place so the provider-specific bind details can drop in later.
export class SmppSmsProvider implements SmsProvider {
  #config: SmppSmsConfig;
  #credentials: Record<string, unknown>;
  #enquireLinkTimer: ReturnType<typeof setInterval> | null = null;
  #recentSubmitTimes: number[] = [];
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  #session: SmppBoundSessionLike | null = null;
  #sessionPromise: Promise<SmppBoundSessionLike | null> | null = null;
  #transport: SmppTransportLike | null;

  constructor(input: SmppSmsProviderInput) {
    this.#config = normalizeSmppConfig(input.config);
    this.#credentials =
      input.credentials && typeof input.credentials === "object" && !Array.isArray(input.credentials)
        ? (input.credentials as Record<string, unknown>)
        : {};
    this.#transport = input.transport ?? null;
  }

  async send(msg: SmsMessageRequest): Promise<ProviderResult> {
    const segments = splitSmsMessage(
      msg.body,
      this.#config.long_message_segment_chars ?? 153
    );

    const session = await this.#ensureBoundSession();
    if (!session) {
      return {
        failureCode: "provider_error",
        outcome: "failed",
        providerStatus: "not_configured",
        rawRedacted: {
          provider_code: "sms_smpp",
          segment_count: segments.length,
          todo_spec: true,
          tps: this.#config.tps ?? null
        }
      };
    }

    const messageIds: string[] = [];

    try {
      for (let index = 0; index < segments.length; index += 1) {
        await this.#waitForThroughputWindow();
        const response = await session.submitSm({
          destinationAddr: msg.to,
          partNumber: index + 1,
          reference: msg.reference,
          shortMessage: segments[index]!,
          sourceAddr: msg.senderId,
          totalParts: segments.length
        });
        messageIds.push(response.messageId);
      }
    } catch (error) {
      this.#markDisconnected();

      return {
        failureCode: "provider_error",
        outcome: "failed",
        providerStatus: "submit_failed",
        rawRedacted: {
          error: error instanceof Error ? error.message : "SMPP submit failed",
          provider_code: "sms_smpp",
          segment_count: segments.length
        }
      };
    }

    return {
      outcome: "accepted",
      providerRef: messageIds[0] ?? `smpp_${msg.reference}`,
      providerStatus: "submitted",
      rawRedacted: {
        message_ids: messageIds,
        provider_code: "sms_smpp",
        segment_count: segments.length,
        todo_spec: true
      }
    };
  }

  async parseDeliveryReport(rawBody: string): Promise<NormalizedEvent> {
    try {
      const parsed = JSON.parse(rawBody) as Record<string, unknown>;
      const status =
        typeof parsed.status === "string" ? parsed.status.toLowerCase() : "unknown";

      return {
        eventType: "sms.delivery_report",
        ...(typeof parsed.message_id === "string"
          ? { providerRef: parsed.message_id }
          : {}),
        rawRedacted: parsed as NormalizedEvent["rawRedacted"],
        ...(typeof parsed.resource_id === "string"
          ? { resourceId: parsed.resource_id, resourceType: "sms" }
          : {}),
        toStatus:
          status === "delivered"
            ? "delivered"
            : status === "undelivered"
              ? "undelivered"
              : status === "rejected"
                ? "failed"
                : "unknown"
      };
    } catch {
      return {
        eventType: "sms.delivery_report",
        rawRedacted: {
          raw_body: "[UNPARSEABLE]"
        }
      };
    }
  }

  async getBalance(): Promise<ProviderResult> {
    return {
      outcome: "unknown",
      providerRef: "sms_smpp_balance",
      providerStatus: "unsupported",
      rawRedacted: {
        provider_code: "sms_smpp",
        todo_spec: true
      }
    };
  }

  async healthCheck(): Promise<ProviderResult> {
    if (!this.#transport) {
      return {
        outcome: "unknown",
        providerRef: "sms_smpp",
        providerStatus: "not_configured",
        rawRedacted: {
          provider_code: "sms_smpp",
          todo_spec: true
        }
      };
    }

    const session = await this.#ensureBoundSession();
    if (!session) {
      return {
        failureCode: "provider_error",
        outcome: "failed",
        providerRef: "sms_smpp",
        providerStatus: "disconnected",
        rawRedacted: {
          provider_code: "sms_smpp"
        }
      };
    }

    return {
      outcome: "succeeded",
      providerRef: "sms_smpp",
      providerStatus: "bound",
      rawRedacted: {
        provider_code: "sms_smpp",
        tps: this.#config.tps ?? null
      }
    };
  }

  async #ensureBoundSession(): Promise<SmppBoundSessionLike | null> {
    if (this.#session) {
      return this.#session;
    }

    if (this.#sessionPromise) {
      return this.#sessionPromise;
    }

    if (!this.#transport || !this.#config.host || !this.#config.port) {
      return null;
    }

    this.#sessionPromise = (async () => {
      try {
        const connectInput = {
          host: this.#config.host!,
          port: this.#config.port!,
          timeoutMs: this.#config.timeout_ms ?? 10_000,
          ...(typeof this.#credentials.password === "string"
            ? { password: this.#credentials.password }
            : {}),
          ...(typeof this.#credentials.system_id === "string"
            ? { systemId: this.#credentials.system_id }
            : {})
        };
        const session = await this.#transport!.connect(connectInput);

        await session.bindTransceiver();
        session.onClose?.(() => {
          this.#markDisconnected();
          if (this.#config.auto_reconnect !== false) {
            this.#scheduleReconnect();
          }
        });

        this.#session = session;
        this.#startEnquireLinkLoop();
        return session;
      } catch {
        this.#markDisconnected();
        return null;
      } finally {
        this.#sessionPromise = null;
      }
    })();

    return this.#sessionPromise;
  }

  #startEnquireLinkLoop() {
    if (this.#enquireLinkTimer || !this.#session) {
      return;
    }

    this.#enquireLinkTimer = setInterval(() => {
      if (!this.#session) {
        return;
      }

      void this.#session.enquireLink().catch(() => {
        this.#markDisconnected();
        if (this.#config.auto_reconnect !== false) {
          this.#scheduleReconnect();
        }
      });
    }, this.#config.enquire_link_interval_ms ?? 30_000);
  }

  #scheduleReconnect() {
    if (this.#reconnectTimer) {
      return;
    }

    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      void this.#ensureBoundSession();
    }, this.#config.reconnect_delay_ms ?? 5_000);
  }

  #markDisconnected() {
    if (this.#enquireLinkTimer) {
      clearInterval(this.#enquireLinkTimer);
      this.#enquireLinkTimer = null;
    }

    this.#session = null;
  }

  async #waitForThroughputWindow() {
    const tps = this.#config.tps;
    if (!tps || tps <= 0) {
      return;
    }

    while (true) {
      const now = Date.now();
      this.#recentSubmitTimes = this.#recentSubmitTimes.filter(
        (timestamp) => now - timestamp < 1_000
      );

      if (this.#recentSubmitTimes.length < tps) {
        this.#recentSubmitTimes.push(now);
        return;
      }

      const earliest = this.#recentSubmitTimes[0]!;
      const delayMs = Math.max(5, 1_000 - (now - earliest));
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

export function splitSmsMessage(body: string, segmentChars = 153): string[] {
  const normalized = body.trim();
  if (normalized.length <= segmentChars) {
    return [normalized];
  }

  const segments: string[] = [];
  for (let index = 0; index < normalized.length; index += segmentChars) {
    segments.push(normalized.slice(index, index + segmentChars));
  }

  return segments;
}

function normalizeSmppConfig(config: unknown): SmppSmsConfig {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return {};
  }

  return config as SmppSmsConfig;
}
