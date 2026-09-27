import type {
  CardAcquirer,
  CardPaymentSessionRequest,
  NormalizedEvent,
  ProviderCallbackVerificationInput,
  ProviderResult
} from "./types";

// TODO(spec): replace this config-driven placeholder with the real acquirer contract
// when docs/providers/card_acquirer.md is added to the repo.
export class GenericCardAcquirer implements CardAcquirer {
  #config: Record<string, unknown>;

  constructor(config: unknown) {
    this.#config =
      config && typeof config === "object" && !Array.isArray(config)
        ? (config as Record<string, unknown>)
        : {};
  }

  async createPaymentSession(req: CardPaymentSessionRequest): Promise<ProviderResult> {
    const hostedFieldsUrl =
      typeof this.#config.hosted_fields_url === "string"
        ? this.#config.hosted_fields_url
        : null;
    const redirectUrl =
      typeof this.#config.redirect_url === "string" ? this.#config.redirect_url : null;

    return {
      ...(hostedFieldsUrl
        ? {
            nextAction: {
              iframe_url: `${hostedFieldsUrl}?reference=${encodeURIComponent(req.reference)}`,
              type: "hosted_fields"
            }
          }
        : redirectUrl
          ? {
              nextAction: {
                type: "redirect_url",
                url: `${redirectUrl}?reference=${encodeURIComponent(req.reference)}`
              }
            }
          : {}),
      outcome: "accepted",
      providerRef: `card_generic_${req.reference}`,
      providerStatus: "pending",
      rawRedacted: {
        provider_code: "card_generic",
        return_url: req.returnUrl ?? null,
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
        provider_code: "card_generic",
        todo_spec: true
      }
    };
  }

  async parseCallback(rawBody: string): Promise<NormalizedEvent> {
    try {
      const parsed = JSON.parse(rawBody) as Record<string, unknown>;
      return {
        eventType:
          typeof parsed.event_type === "string"
            ? parsed.event_type
            : "provider.callback",
        ...(typeof parsed.from_status === "string"
          ? { fromStatus: parsed.from_status }
          : {}),
        ...(parsed.mode === "test" || parsed.mode === "live"
          ? { mode: parsed.mode }
          : {}),
        ...(typeof parsed.provider_ref === "string"
          ? { providerRef: parsed.provider_ref }
          : {}),
        rawRedacted: parsed as ProviderResult["rawRedacted"],
        ...(typeof parsed.reason === "string" ? { reason: parsed.reason } : {}),
        ...(typeof parsed.resource_id === "string"
          ? { resourceId: parsed.resource_id }
          : {}),
        ...(typeof parsed.resource_type === "string"
          ? { resourceType: parsed.resource_type }
          : {}),
        ...(typeof parsed.to_status === "string" ? { toStatus: parsed.to_status } : {})
      };
    } catch {
      return {
        eventType: "provider.callback",
        rawRedacted: {
          raw_body: "[UNPARSEABLE]"
        }
      };
    }
  }

  async refund(ref: string, amount: number): Promise<ProviderResult> {
    return {
      outcome: "accepted",
      providerRef: `refund_${ref}`,
      providerStatus: "pending",
      rawRedacted: {
        amount,
        provider_code: "card_generic",
        reference: ref,
        todo_spec: true
      }
    };
  }

  async healthCheck(): Promise<ProviderResult> {
    return {
      outcome: "unknown",
      providerRef: "card_generic",
      providerStatus: "not_configured",
      rawRedacted: {
        provider_code: "card_generic",
        todo_spec: true
      }
    };
  }

  verifyCallback(_input: ProviderCallbackVerificationInput): boolean {
    return true;
  }
}
