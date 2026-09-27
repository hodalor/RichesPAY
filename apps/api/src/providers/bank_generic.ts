import type {
  BankPayoutProvider,
  BankPayoutRequest,
  NormalizedEvent,
  ProviderCallbackVerificationInput,
  ProviderResult
} from "./types";

export class GenericBankPayoutProvider implements BankPayoutProvider {
  constructor(_config: unknown) {}

  async payout(req: BankPayoutRequest): Promise<ProviderResult> {
    return {
      outcome: "accepted",
      providerRef: `bank_generic_${req.reference}`,
      providerStatus: "queued",
      rawRedacted: {
        account_name: req.accountName ?? null,
        bank_code: req.bankCode,
        currency: req.currency,
        provider_code: "bank_generic",
        todo_spec: true
      }
    };
  }

  async getStatus(ref: string): Promise<ProviderResult> {
    return {
      outcome: "unknown",
      providerRef: ref,
      providerStatus: "unknown",
      rawRedacted: {
        provider_code: "bank_generic",
        provider_ref: ref,
        todo_spec: true
      }
    };
  }

  async parseCallback(rawBody: string): Promise<NormalizedEvent> {
    const parsed = JSON.parse(rawBody) as Record<string, unknown>;

    return {
      eventType:
        typeof parsed.event_type === "string"
          ? parsed.event_type
          : "provider.callback",
      ...(typeof parsed.provider_ref === "string"
        ? { providerRef: parsed.provider_ref }
        : {}),
      rawRedacted: parsed as NormalizedEvent["rawRedacted"],
      ...(typeof parsed.reason === "string" ? { reason: parsed.reason } : {}),
      ...(typeof parsed.resource_id === "string"
        ? { resourceId: parsed.resource_id }
        : {}),
      ...(typeof parsed.resource_type === "string"
        ? { resourceType: parsed.resource_type }
        : {}),
      ...(typeof parsed.to_status === "string" ? { toStatus: parsed.to_status } : {})
    };
  }

  async healthCheck(): Promise<ProviderResult> {
    return {
      outcome: "unknown",
      providerRef: "bank_generic",
      providerStatus: "not_configured",
      rawRedacted: {
        todo_spec: true
      }
    };
  }

  verifyCallback(_input: ProviderCallbackVerificationInput): boolean {
    return true;
  }
}
