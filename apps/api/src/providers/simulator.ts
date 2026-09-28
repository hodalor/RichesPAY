import { createHmac } from "node:crypto";

import type {
  AirtimeFloatBalance,
  AirtimeNetworkOffer,
  AirtimeProvider,
  AirtimeSendRequest,
  BankPayoutProvider,
  BankPayoutRequest,
  CardAcquirer,
  CardPaymentSessionRequest,
  MobileMoneyCollectRequest,
  MobileMoneyPayoutRequest,
  MobileMoneyProvider,
  NormalizedEvent,
  ProviderCallbackVerificationInput,
  ProviderResult,
  SmsMessageRequest,
  SmsProvider
} from "./types";
import {
  normalizeMobileMoneyPhoneNumber
} from "./mobile-money/phone";

function successResult(providerRef: string, providerStatus: string, raw: unknown): ProviderResult {
  return {
    outcome: "succeeded",
    providerRef,
    providerStatus,
    rawRedacted: raw as ProviderResult["rawRedacted"]
  };
}

function parseSimulatorBody(rawBody: string): NormalizedEvent {
  const parsed = JSON.parse(rawBody) as Record<string, unknown>;
  const event: NormalizedEvent = {
    eventType: stringOrUndefined(parsed.event_type) ?? "provider.callback",
    rawRedacted: parsed as NormalizedEvent["rawRedacted"]
  };

  const eventId = stringOrUndefined(parsed.event_id);
  const fromStatus = stringOrUndefined(parsed.from_status);
  const merchantId = stringOrUndefined(parsed.merchant_id);
  const providerRef = stringOrUndefined(parsed.provider_ref);
  const reason = stringOrUndefined(parsed.reason);
  const resourceId = stringOrUndefined(parsed.resource_id);
  const resourceType = stringOrUndefined(parsed.resource_type);
  const toStatus = stringOrUndefined(parsed.to_status);
  const mode = parsed.mode === "test" || parsed.mode === "live" ? parsed.mode : undefined;

  if (eventId) event.eventId = eventId;
  if (fromStatus) event.fromStatus = fromStatus;
  if (merchantId) event.merchantId = merchantId;
  if (mode) event.mode = mode;
  if (providerRef) event.providerRef = providerRef;
  if (reason) event.reason = reason;
  if (resourceId) event.resourceId = resourceId;
  if (resourceType) event.resourceType = resourceType;
  if (toStatus) event.toStatus = toStatus;

  return event;
}

function verifySimulatorCallback(input: ProviderCallbackVerificationInput): boolean {
  const provided = input.headers["x-richespay-simulator-signature"];
  const signature = Array.isArray(provided) ? provided[0] : provided;

  if (!signature) {
    return true;
  }

  const expected = createHmac("sha256", "richespay_simulator_callback_secret")
    .update(input.rawBody)
    .digest("hex");

  return signature === expected || signature === "ok";
}

export class SimulatorMobileMoneyProvider implements MobileMoneyProvider {
  async collect(req: MobileMoneyCollectRequest): Promise<ProviderResult> {
    const normalizedMsisdn = normalizeMobileMoneyPhoneNumber(
      req.msisdn,
      guessCountryFromCurrency(req.currency)
    );
    const scenario = getSimulatorScenario(normalizedMsisdn);

    switch (scenario) {
      case "insufficient_funds":
        return {
          failureCode: "insufficient_funds",
          outcome: "failed",
          providerRef: buildSimulatorProviderRef("collect", req.reference, scenario),
          providerStatus: "insufficient_funds",
          rawRedacted: {
            amount: req.amount,
            currency: req.currency,
            msisdn: normalizedMsisdn,
            scenario
          }
        };
      case "customer_declined":
        return {
          failureCode: "provider_error",
          outcome: "failed",
          providerRef: buildSimulatorProviderRef("collect", req.reference, scenario),
          providerStatus: "customer_declined",
          rawRedacted: {
            amount: req.amount,
            currency: req.currency,
            msisdn: normalizedMsisdn,
            scenario
          }
        };
      case "timeout_then_status_success":
        return {
          outcome: "unknown",
          providerRef: buildSimulatorProviderRef("collect", req.reference, scenario),
          providerStatus: "timeout",
          rawRedacted: {
            amount: req.amount,
            currency: req.currency,
            msisdn: normalizedMsisdn,
            scenario
          }
        };
      case "status_poll_success":
        return {
          outcome: "accepted",
          providerRef: buildSimulatorProviderRef("collect", req.reference, scenario),
          providerStatus: "pending",
          rawRedacted: {
            amount: req.amount,
            currency: req.currency,
            msisdn: normalizedMsisdn,
            no_callback: true,
            scenario
          }
        };
      case "callback_success_5s":
        return {
          outcome: "accepted",
          providerRef: buildSimulatorProviderRef("collect", req.reference, scenario),
          providerStatus: "accepted",
          rawRedacted: {
            amount: req.amount,
            callback_after_seconds: 5,
            callback_body: buildSimulatorCallbackBody({
              delaySeconds: 5,
              mode: req.context.mode,
              providerRef: buildSimulatorProviderRef("collect", req.reference, scenario),
              reference: req.reference,
              status: "succeeded"
            }),
            currency: req.currency,
            msisdn: normalizedMsisdn,
            scenario
          }
        };
      case "callback_success_3s":
      default:
        return {
          outcome: "accepted",
          providerRef: buildSimulatorProviderRef("collect", req.reference, scenario),
          providerStatus: "accepted",
          rawRedacted: {
            amount: req.amount,
            callback_after_seconds: 3,
            callback_body: buildSimulatorCallbackBody({
              delaySeconds: 3,
              mode: req.context.mode,
              providerRef: buildSimulatorProviderRef("collect", req.reference, scenario),
              reference: req.reference,
              status: "succeeded"
            }),
            currency: req.currency,
            msisdn: normalizedMsisdn,
            scenario
          }
        };
    }
  }

  async getStatus(providerRef: string): Promise<ProviderResult> {
    const scenario = parseScenarioFromProviderRef(providerRef);

    if (
      scenario === "status_poll_success" ||
      scenario === "timeout_then_status_success"
    ) {
      return successResult(providerRef, "succeeded", {
        provider_ref: providerRef,
        scenario
      });
    }

    if (scenario === "insufficient_funds") {
      return {
        failureCode: "insufficient_funds",
        outcome: "failed",
        providerRef,
        providerStatus: "insufficient_funds",
        rawRedacted: {
          provider_ref: providerRef,
          scenario
        }
      };
    }

    if (scenario === "customer_declined") {
      return {
        failureCode: "provider_error",
        outcome: "failed",
        providerRef,
        providerStatus: "customer_declined",
        rawRedacted: {
          provider_ref: providerRef,
          scenario
        }
      };
    }

    return successResult(providerRef, "succeeded", {
      provider_ref: providerRef,
      scenario
    });
  }

  async healthCheck(): Promise<ProviderResult> {
    return successResult("simulator", "healthy", { provider: "simulator" });
  }

  async lookupAccountName(msisdn: string): Promise<ProviderResult> {
    const normalizedMsisdn = normalizeMobileMoneyPhoneNumber(
      msisdn,
      guessCountryFromMsisdn(msisdn)
    );

    return successResult(`lookup_${normalizedMsisdn}`, "succeeded", {
      account_name: "Simulator User",
      msisdn: normalizedMsisdn
    });
  }

  async parseCallback(rawBody: string): Promise<NormalizedEvent> {
    return parseSimulatorBody(rawBody);
  }

  async payout(req: MobileMoneyPayoutRequest): Promise<ProviderResult> {
    return this.collect({
      ...req
    });
  }

  verifyCallback(input: ProviderCallbackVerificationInput): boolean {
    return verifySimulatorCallback(input);
  }
}

export class SimulatorCardAcquirer implements CardAcquirer {
  #config: Record<string, unknown>;

  constructor(config?: unknown) {
    this.#config =
      config && typeof config === "object" && !Array.isArray(config)
        ? (config as Record<string, unknown>)
        : {};
  }

  async createPaymentSession(req: CardPaymentSessionRequest): Promise<ProviderResult> {
    const providerRef = `sim_card_${req.reference}`;
    const checkoutOrigin =
      typeof this.#config.checkout_origin === "string"
        ? this.#config.checkout_origin
        : "http://127.0.0.1:5175";

    return {
      nextAction: {
        iframe_url: `${checkoutOrigin}/simulator/card-fields?collection_id=${encodeURIComponent(req.reference)}&provider_ref=${encodeURIComponent(providerRef)}&callback_url=${encodeURIComponent(req.callbackUrl ?? "")}&return_url=${encodeURIComponent(req.returnUrl ?? "")}&cancel_url=${encodeURIComponent(req.cancelUrl ?? "")}&currency=${encodeURIComponent(req.currency)}&amount=${encodeURIComponent(String(req.amount))}`,
        type: "hosted_fields"
      },
      outcome: "accepted",
      providerRef,
      providerStatus: "pending",
      rawRedacted: {
        amount: req.amount,
        currency: req.currency,
        reference: req.reference,
        simulator: {
          accepted_cards: [
            "4000000000000001",
            "4000000000000002",
            "4000000000000003"
          ],
          callback_url: req.callbackUrl ?? null,
          hosted_fields: true
        }
      }
    };
  }

  async getStatus(ref: string): Promise<ProviderResult> {
    if (ref.includes("_declined")) {
      return {
        failureCode: "provider_error",
        outcome: "failed",
        providerRef: ref,
        providerStatus: "declined",
        rawRedacted: {
          provider_ref: ref
        }
      };
    }

    return successResult(ref, "succeeded", { provider_ref: ref });
  }

  async healthCheck(): Promise<ProviderResult> {
    return successResult("simulator", "healthy", { provider: "simulator" });
  }

  async parseCallback(rawBody: string): Promise<NormalizedEvent> {
    return parseSimulatorBody(rawBody);
  }

  async refund(ref: string, amount: number): Promise<ProviderResult> {
    return successResult(ref, "succeeded", { amount, provider_ref: ref });
  }

  verifyCallback(input: ProviderCallbackVerificationInput): boolean {
    return verifySimulatorCallback(input);
  }
}

export class SimulatorBankPayoutProvider implements BankPayoutProvider {
  async payout(req: BankPayoutRequest): Promise<ProviderResult> {
    const scenario = getSimulatorBankScenario(req.accountNumber);
    const providerRef = buildSimulatorProviderRef("payout", req.reference, scenario);

    switch (scenario) {
      case "insufficient_funds":
        return {
          failureCode: "insufficient_funds",
          outcome: "failed",
          providerRef,
          providerStatus: "insufficient_funds",
          rawRedacted: {
            account_number_last4: req.accountNumber.slice(-4),
            bank_code: req.bankCode,
            scenario
          }
        };
      case "customer_declined":
        return {
          failureCode: "provider_error",
          outcome: "failed",
          providerRef,
          providerStatus: "account_rejected",
          rawRedacted: {
            account_number_last4: req.accountNumber.slice(-4),
            bank_code: req.bankCode,
            scenario
          }
        };
      case "timeout_then_status_success":
        return {
          outcome: "unknown",
          providerRef,
          providerStatus: "timeout",
          rawRedacted: {
            account_number_last4: req.accountNumber.slice(-4),
            bank_code: req.bankCode,
            scenario
          }
        };
      case "status_poll_success":
        return {
          outcome: "accepted",
          providerRef,
          providerStatus: "pending",
          rawRedacted: {
            account_number_last4: req.accountNumber.slice(-4),
            bank_code: req.bankCode,
            no_callback: true,
            scenario
          }
        };
      default:
        return {
          outcome: "accepted",
          providerRef,
          providerStatus: "accepted",
          rawRedacted: {
            account_number_last4: req.accountNumber.slice(-4),
            bank_code: req.bankCode,
            scenario
          }
        };
    }
  }

  async getStatus(providerRef: string): Promise<ProviderResult> {
    const scenario = parseScenarioFromProviderRef(providerRef);

    if (
      scenario === "status_poll_success" ||
      scenario === "timeout_then_status_success"
    ) {
      return successResult(providerRef, "succeeded", {
        provider_ref: providerRef,
        scenario
      });
    }

    if (scenario === "insufficient_funds") {
      return {
        failureCode: "insufficient_funds",
        outcome: "failed",
        providerRef,
        providerStatus: "insufficient_funds",
        rawRedacted: {
          provider_ref: providerRef,
          scenario
        }
      };
    }

    if (scenario === "customer_declined") {
      return {
        failureCode: "provider_error",
        outcome: "failed",
        providerRef,
        providerStatus: "account_rejected",
        rawRedacted: {
          provider_ref: providerRef,
          scenario
        }
      };
    }

    return successResult(providerRef, "succeeded", {
      provider_ref: providerRef,
      scenario
    });
  }

  async healthCheck(): Promise<ProviderResult> {
    return successResult("simulator_bank", "healthy", { provider: "simulator" });
  }

  async parseCallback(rawBody: string): Promise<NormalizedEvent> {
    return parseSimulatorBody(rawBody);
  }

  verifyCallback(input: ProviderCallbackVerificationInput): boolean {
    return verifySimulatorCallback(input);
  }
}

export class SimulatorSmsProvider implements SmsProvider {
  async getBalance(): Promise<ProviderResult> {
    return successResult("sim_sms_balance", "succeeded", { balance: 1000 });
  }

  async healthCheck(): Promise<ProviderResult> {
    return successResult("simulator", "healthy", { provider: "simulator" });
  }

  async parseDeliveryReport(rawBody: string): Promise<NormalizedEvent> {
    return parseSimulatorBody(rawBody);
  }

  async send(msg: SmsMessageRequest): Promise<ProviderResult> {
    const scenario = getSimulatorSmsScenario(msg.to);

    if (scenario === "rejected") {
      return {
        failureCode: "provider_error",
        outcome: "failed",
        providerRef: `sim_sms_${msg.reference}`,
        providerStatus: "rejected",
        rawRedacted: {
          reference: msg.reference,
          scenario,
          sender_id: msg.senderId,
          to: msg.to
        }
      };
    }

    return {
      outcome: "accepted",
      providerRef: `sim_sms_${msg.reference}`,
      providerStatus: "accepted",
      rawRedacted: {
        delivery_report: {
          event_type: "sms.delivery_report",
          provider_ref: `sim_sms_${msg.reference}`,
          resource_id: msg.reference,
          status: scenario
        },
        reference: msg.reference,
        scenario,
        sender_id: msg.senderId,
        to: msg.to
      }
    };
  }
}

type SimulatorAirtimeScenario =
  | "invalid_phone_number"
  | "pending_then_success"
  | "succeeded"
  | "timeout_then_success"
  | "unavailable";

/**
 * Test numbers: ...0001 succeeds, ...0002 fails with invalid_phone_number,
 * ...0003 stays pending until a status check, ...0004 fails with
 * airtime_unavailable, ...0005 times out (unknown) and succeeds on status check.
 */
export class SimulatorAirtimeProvider implements AirtimeProvider {
  async listNetworks(countryCode: string): Promise<AirtimeNetworkOffer[]> {
    return countryCode.toUpperCase() === "ZM"
      ? [
          { currency: "ZMW", network: "MTN" },
          { currency: "ZMW", network: "AIRTEL" },
          { currency: "ZMW", network: "ZAMTEL" }
        ]
      : [
          { currency: "GHS", network: "MTN" },
          { currency: "GHS", network: "TELECEL" },
          { currency: "GHS", network: "AT" }
        ];
  }

  async sendAirtime(req: AirtimeSendRequest): Promise<ProviderResult> {
    const scenario = getSimulatorAirtimeScenario(req.msisdn);
    const providerRef = `sim_air_${scenario}_${req.reference}`;
    const raw = { provider_ref: providerRef, reference: req.reference, scenario };

    switch (scenario) {
      case "invalid_phone_number":
        return {
          failureCode: "invalid_phone_number",
          outcome: "failed",
          providerRef,
          providerStatus: "invalid_msisdn",
          rawRedacted: raw
        };
      case "unavailable":
        return {
          failureCode: "airtime_unavailable",
          outcome: "failed",
          providerRef,
          providerStatus: "airtime_unavailable",
          rawRedacted: raw
        };
      case "pending_then_success":
        return { outcome: "accepted", providerRef, providerStatus: "pending", rawRedacted: raw };
      case "timeout_then_success":
        return { outcome: "unknown", providerRef, providerStatus: "timeout", rawRedacted: raw };
      case "succeeded":
        return successResult(providerRef, "successful", raw);
    }
  }

  async getStatus(providerRef: string): Promise<ProviderResult> {
    if (providerRef.startsWith("sim_air_invalid_phone_number_")) {
      return {
        failureCode: "invalid_phone_number",
        outcome: "failed",
        providerRef,
        providerStatus: "invalid_msisdn",
        rawRedacted: { provider_ref: providerRef }
      };
    }

    if (providerRef.startsWith("sim_air_unavailable_")) {
      return {
        failureCode: "airtime_unavailable",
        outcome: "failed",
        providerRef,
        providerStatus: "airtime_unavailable",
        rawRedacted: { provider_ref: providerRef }
      };
    }

    return successResult(providerRef, "successful", { provider_ref: providerRef });
  }

  async getFloatBalance(): Promise<AirtimeFloatBalance> {
    return {
      balanceMinor: 100_000_000,
      currency: null,
      rawRedacted: { provider: "simulator" }
    };
  }

  async healthCheck(): Promise<ProviderResult> {
    return successResult("simulator_airtime", "healthy", { provider: "simulator" });
  }

  async parseCallback(rawBody: string): Promise<NormalizedEvent> {
    return parseSimulatorBody(rawBody);
  }

  verifyCallback(input: ProviderCallbackVerificationInput): boolean {
    return verifySimulatorCallback(input);
  }
}

function getSimulatorAirtimeScenario(msisdn: string): SimulatorAirtimeScenario {
  const digits = msisdn.replace(/[^\d]/g, "");

  if (digits.endsWith("0002")) {
    return "invalid_phone_number";
  }

  if (digits.endsWith("0003")) {
    return "pending_then_success";
  }

  if (digits.endsWith("0004")) {
    return "unavailable";
  }

  if (digits.endsWith("0005")) {
    return "timeout_then_success";
  }

  return "succeeded";
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

type SimulatorScenario =
  | "callback_success_3s"
  | "callback_success_5s"
  | "customer_declined"
  | "insufficient_funds"
  | "status_poll_success"
  | "timeout_then_status_success";

function buildSimulatorCallbackBody(input: {
  delaySeconds: number;
  mode: "live" | "test";
  providerRef: string;
  reference: string;
  status: string;
}) {
  return {
    delay_seconds: input.delaySeconds,
    event_id: `sim_evt_${input.reference}`,
    event_type: "collection.updated",
    mode: input.mode,
    provider_ref: input.providerRef,
    resource_id: input.reference,
    resource_type: "collection",
    status: input.status,
    to_status: input.status
  };
}

function buildSimulatorProviderRef(
  operation: "collect" | "payout",
  reference: string,
  scenario: SimulatorScenario
) {
  return `sim_${operation}_${scenario}_${reference}`;
}

function getSimulatorScenario(msisdn: string): SimulatorScenario {
  if (msisdn.endsWith("0001")) {
    return "callback_success_5s";
  }

  if (msisdn.endsWith("0002")) {
    return "insufficient_funds";
  }

  if (msisdn.endsWith("0003")) {
    return "status_poll_success";
  }

  if (msisdn.endsWith("0004")) {
    return "customer_declined";
  }

  if (msisdn.endsWith("0005")) {
    return "timeout_then_status_success";
  }

  return "callback_success_3s";
}

function guessCountryFromCurrency(currency: string): "GH" | "ZM" {
  return currency === "ZMW" ? "ZM" : "GH";
}

function guessCountryFromMsisdn(msisdn: string): "GH" | "ZM" {
  return msisdn.trim().startsWith("+260") ? "ZM" : "GH";
}

function parseScenarioFromProviderRef(providerRef: string): SimulatorScenario {
  if (providerRef.includes("_callback_success_5s_")) {
    return "callback_success_5s";
  }

  if (providerRef.includes("_insufficient_funds_")) {
    return "insufficient_funds";
  }

  if (providerRef.includes("_status_poll_success_")) {
    return "status_poll_success";
  }

  if (providerRef.includes("_customer_declined_")) {
    return "customer_declined";
  }

  if (providerRef.includes("_timeout_then_status_success_")) {
    return "timeout_then_status_success";
  }

  return "callback_success_3s";
}

function getSimulatorBankScenario(accountNumber: string): SimulatorScenario {
  const digits = accountNumber.replace(/[^\d]/g, "");

  if (digits.endsWith("0002")) {
    return "insufficient_funds";
  }

  if (digits.endsWith("0003")) {
    return "status_poll_success";
  }

  if (digits.endsWith("0004")) {
    return "customer_declined";
  }

  if (digits.endsWith("0005")) {
    return "timeout_then_status_success";
  }

  if (digits.endsWith("0001")) {
    return "callback_success_5s";
  }

  return "callback_success_3s";
}

function getSimulatorSmsScenario(phoneNumber: string): "delivered" | "rejected" | "undelivered" {
  const digits = phoneNumber.replace(/[^\d]/g, "");

  if (digits.endsWith("0002")) {
    return "undelivered";
  }

  if (digits.endsWith("0003")) {
    return "rejected";
  }

  return "delivered";
}
