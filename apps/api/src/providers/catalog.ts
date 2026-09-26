import { createHmac, timingSafeEqual } from "node:crypto";

import ipaddr from "ipaddr.js";

import type { AppDatabase } from "../db";
import type {
  CardAcquirer,
  ChannelRecord,
  MobileMoneyProvider,
  NormalizedEvent,
  ProviderCallbackVerificationInput,
  ProviderHttpTransport,
  ProviderResult,
  SmsMessageRequest,
  SmsProvider
} from "./types";
import { AirtelMoneyProvider } from "./airtel_money";
import { AtMoneyProvider } from "./at_money";
import { CredentialEncryptionService } from "./crypto";
import { HttpProviderClient } from "./http-client";
import { MtnMomoProvider } from "./mtn_momo";
import { TelecelCashProvider } from "./telecel_cash";
import {
  SimulatorCardAcquirer,
  SimulatorMobileMoneyProvider,
  SimulatorSmsProvider
} from "./simulator";
import { ZamtelMoneyProvider } from "./zamtel_money";

export class ProviderCatalog {
  #adapterCache = new Map<string, CardAcquirer | MobileMoneyProvider | SmsProvider>();
  #encryption: CredentialEncryptionService | null;
  #transport: ProviderHttpTransport | null;

  constructor(input?: {
    database?: AppDatabase;
    encryptionKey?: string;
    transport?: ProviderHttpTransport;
  }) {
    this.#encryption = input?.encryptionKey
      ? new CredentialEncryptionService(input.encryptionKey)
      : null;
    this.#transport =
      input?.transport ??
      (input?.database ? new HttpProviderClient(input.database) : null);
  }

  resolveCardAcquirer(channel: ChannelRecord): CardAcquirer {
    if (channel.providerCode === "simulator") {
      return new SimulatorCardAcquirer();
    }

    return new PassiveCardAcquirer(channel.providerCode, channel.config);
  }

  resolveMobileMoneyProvider(channel: ChannelRecord): MobileMoneyProvider {
    if (channel.providerCode === "simulator") {
      return new SimulatorMobileMoneyProvider();
    }

    const cached = this.#adapterCache.get(channel.id);
    if (cached) {
      return cached as MobileMoneyProvider;
    }

    const credentials = this.#decryptCredentials(channel.credentialsEncrypted);
    const transport = this.#requireTransport(channel.providerCode);
    const adapterInput = {
      channelId: channel.id,
      config: channel.config,
      countryCode: channel.countryCode,
      credentials,
      transport
    };

    const adapter = (() => {
      switch (channel.providerCode) {
        case "airtel_money":
          return new AirtelMoneyProvider(adapterInput);
        case "at_money":
          return new AtMoneyProvider(adapterInput);
        case "mtn_momo":
          return new MtnMomoProvider(adapterInput);
        case "telecel_cash":
          return new TelecelCashProvider(adapterInput);
        case "zamtel_money":
          return new ZamtelMoneyProvider(adapterInput);
        default:
          return new SimulatorMobileMoneyProvider();
      }
    })();

    this.#adapterCache.set(channel.id, adapter);
    return adapter;
  }

  resolveSmsProvider(channel: ChannelRecord): SmsProvider {
    if (channel.providerCode === "simulator") {
      return new SimulatorSmsProvider();
    }

    return new PassiveSmsProvider(channel.providerCode, channel.config);
  }

  #decryptCredentials(payload: string): unknown {
    if (!this.#encryption) {
      return {};
    }

    return this.#encryption.decrypt(payload);
  }

  #requireTransport(providerCode: string): ProviderHttpTransport {
    if (!this.#transport) {
      throw new Error(
        `No provider HTTP transport configured for ${providerCode}`
      );
    }

    return this.#transport;
  }
}

class PassiveCardAcquirer implements CardAcquirer {
  #providerCode: string;
  #config: unknown;

  constructor(providerCode: string, config: unknown) {
    this.#providerCode = providerCode;
    this.#config = config;
  }

  async createPaymentSession(req: {
    reference: string;
  }): Promise<ProviderResult> {
    return accepted(this.#providerCode, `queued:${req.reference}`, this.#config);
  }

  async getStatus(ref: string): Promise<ProviderResult> {
    return unknown(this.#providerCode, ref, this.#config);
  }

  async healthCheck(): Promise<ProviderResult> {
    return {
      outcome: "unknown",
      providerRef: this.#providerCode,
      providerStatus: "not_configured",
      rawRedacted: null
    };
  }

  async parseCallback(rawBody: string): Promise<NormalizedEvent> {
    return parsePassiveCallback(rawBody);
  }

  async refund(ref: string): Promise<ProviderResult> {
    return accepted(this.#providerCode, `refund:${ref}`, this.#config);
  }

  verifyCallback(input: ProviderCallbackVerificationInput): boolean {
    return verifyPassiveCallback(input, this.#config);
  }
}

class PassiveSmsProvider implements SmsProvider {
  #providerCode: string;
  #config: unknown;

  constructor(providerCode: string, config: unknown) {
    this.#providerCode = providerCode;
    this.#config = config;
  }

  async getBalance(): Promise<ProviderResult> {
    return unknown(this.#providerCode, "balance", this.#config);
  }

  async healthCheck(): Promise<ProviderResult> {
    return {
      outcome: "unknown",
      providerRef: this.#providerCode,
      providerStatus: "not_configured",
      rawRedacted: null
    };
  }

  async parseDeliveryReport(rawBody: string): Promise<NormalizedEvent> {
    return parsePassiveCallback(rawBody);
  }

  async send(msg: SmsMessageRequest): Promise<ProviderResult> {
    return accepted(this.#providerCode, `queued:${msg.reference}`, this.#config);
  }
}

function accepted(providerCode: string, providerRef: string, config: unknown): ProviderResult {
  return {
    outcome: "accepted",
    providerRef,
    providerStatus: "accepted",
    rawRedacted: {
      provider_code: providerCode,
      routing_configured: config !== null && config !== undefined
    }
  };
}

function unknown(providerCode: string, providerRef: string, config: unknown): ProviderResult {
  return {
    outcome: "unknown",
    providerRef,
    providerStatus: "unknown",
    rawRedacted: {
      provider_code: providerCode,
      routing_configured: config !== null && config !== undefined
    }
  };
}

function parsePassiveCallback(rawBody: string): NormalizedEvent {
  try {
    const parsed = JSON.parse(rawBody) as Record<string, unknown>;
    const event: NormalizedEvent = {
      eventType:
        typeof parsed.event_type === "string"
          ? parsed.event_type
          : "provider.callback",
      rawRedacted: parsed as NormalizedEvent["rawRedacted"]
    };

    if (typeof parsed.event_id === "string") event.eventId = parsed.event_id;
    if (typeof parsed.from_status === "string") event.fromStatus = parsed.from_status;
    if (typeof parsed.merchant_id === "string") event.merchantId = parsed.merchant_id;
    if (parsed.mode === "test" || parsed.mode === "live") event.mode = parsed.mode;
    if (typeof parsed.provider_ref === "string") event.providerRef = parsed.provider_ref;
    if (typeof parsed.reason === "string") event.reason = parsed.reason;
    if (typeof parsed.resource_id === "string") event.resourceId = parsed.resource_id;
    if (typeof parsed.resource_type === "string") event.resourceType = parsed.resource_type;
    if (typeof parsed.to_status === "string") event.toStatus = parsed.to_status;

    return event;
  } catch {
    return {
      eventType: "provider.callback",
      rawRedacted: {
        raw_body: "[UNPARSEABLE]"
      }
    };
  }
}

function verifyPassiveCallback(
  input: ProviderCallbackVerificationInput,
  config: unknown
): boolean {
  const callbackConfig = config as {
    callback_ip_allowlist?: string[];
    callback_secret?: string;
  } | null;

  if (callbackConfig?.callback_ip_allowlist?.length) {
    const clientIp = ipaddr.parse(input.ip);
    const allowed = callbackConfig.callback_ip_allowlist.some((entry) => {
      const [range, prefixLength] = ipaddr.parseCIDR(entry);
      return clientIp.kind() === range.kind() && clientIp.match([range, prefixLength]);
    });

    if (!allowed) {
      return false;
    }
  }

  if (callbackConfig?.callback_secret) {
    const provided = input.headers["x-provider-signature"];
    const signature = Array.isArray(provided) ? provided[0] : provided;
    if (!signature) {
      return false;
    }

    const expected = createHmac("sha256", callbackConfig.callback_secret)
      .update(input.rawBody)
      .digest("hex");

    const left = Buffer.from(expected, "utf8");
    const right = Buffer.from(signature, "utf8");
    return left.length === right.length && timingSafeEqual(left, right);
  }

  return true;
}
