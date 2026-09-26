import { describe, expect, it } from "vitest";

import {
  AirtelMoneyProvider,
  AtMoneyProvider,
  MtnMomoProvider,
  type OAuthTokenPayload,
  TelecelCashProvider,
  ZamtelMoneyProvider
} from "../src/providers";
import type {
  MobileMoneyProvider,
  ProviderHttpRequest,
  ProviderHttpResponse,
  ProviderHttpTransport
} from "../src/providers";
import type { MobileMoneyAdapterFixtures } from "../src/providers";
import { airtelMoneyFixtures } from "../src/providers/airtel_money/fixtures";
import { atMoneyFixtures } from "../src/providers/at_money/fixtures";
import { mtnMomoFixtures } from "../src/providers/mtn_momo/fixtures";
import { telecelCashFixtures } from "../src/providers/telecel_cash/fixtures";
import { zamtelMoneyFixtures } from "../src/providers/zamtel_money/fixtures";

interface MobileMoneyAdapterDescriptor {
  countryCode: string;
  fixtures: MobileMoneyAdapterFixtures;
  name: string;
  numbers: {
    invalidCountry: string;
    valid: string;
  };
  createProvider(transport: FixtureTransport): MobileMoneyProvider;
}

class FixtureTransport implements ProviderHttpTransport {
  readonly requests: ProviderHttpRequest[] = [];
  readonly tokenRequests: string[] = [];
  #fixtures: MobileMoneyAdapterFixtures;

  constructor(fixtures: MobileMoneyAdapterFixtures) {
    this.#fixtures = fixtures;
  }

  async request(input: ProviderHttpRequest): Promise<ProviderHttpResponse> {
    this.requests.push(input);
    const url = new URL(input.url);

    if (url.pathname === this.#fixtures.config.token_path) {
      this.tokenRequests.push(url.pathname);
      return this.#json(this.#fixtures.token);
    }

    if (url.pathname === this.#fixtures.config.request_to_pay_path) {
      const body = asRecord(input.body);
      const reference = typeof body.reference === "string" ? body.reference : "";

      if (reference === this.#fixtures.references.success) {
        return this.#json(this.#fixtures.collect.success.body);
      }

      if (reference === this.#fixtures.references.failure) {
        return this.#json(this.#fixtures.collect.failure.body);
      }

      if (reference === this.#fixtures.references.pending) {
        return this.#json(this.#fixtures.collect.pending.body);
      }

      if (reference === this.#fixtures.references.timeout) {
        throw Object.assign(new Error("Timed out"), {
          code: this.#fixtures.collect.timeout.code
        });
      }
    }

    if (url.pathname === this.#fixtures.config.lookup_path) {
      return this.#json(this.#fixtures.lookup.success.body);
    }

    if (url.pathname === this.#fixtures.config.health_path) {
      return this.#json({
        provider_ref: "health",
        status: "SUCCESS"
      });
    }

    const statusPrefix = this.#fixtures.config.status_path.split("{provider_ref}")[0] ?? "";
    if (url.pathname.startsWith(statusPrefix)) {
      const providerRef = decodeURIComponent(url.pathname.slice(statusPrefix.length));

      if (providerRef.includes("pending_ref")) {
        return this.#json(this.#fixtures.status.pending.body);
      }

      if (providerRef.includes("timeout_ref")) {
        return this.#json(this.#fixtures.status.timeout.body);
      }
    }

    throw new Error(`Unexpected fixture request: ${input.method} ${input.url}`);
  }

  #json(body: Record<string, unknown> | OAuthTokenPayload): ProviderHttpResponse {
    return {
      body: JSON.stringify(body),
      headers: {},
      statusCode: 200
    };
  }
}

const descriptors: MobileMoneyAdapterDescriptor[] = [
  {
    countryCode: "GH",
    fixtures: mtnMomoFixtures,
    name: "mtn_momo (GH)",
    numbers: {
      invalidCountry: "+260977123456",
      valid: "+233244123456"
    },
    createProvider(transport) {
      return new MtnMomoProvider({
        channelId: "chn_mtn_gh",
        config: mtnMomoFixtures.config,
        countryCode: "GH",
        credentials: mtnMomoFixtures.credentials,
        transport
      });
    }
  },
  {
    countryCode: "ZM",
    fixtures: {
      ...mtnMomoFixtures,
      config: {
        ...mtnMomoFixtures.config,
        base_url: "https://mtn_momo_zm.sandbox.example.com"
      }
    },
    name: "mtn_momo (ZM)",
    numbers: {
      invalidCountry: "+233244123456",
      valid: "+260977123456"
    },
    createProvider(transport) {
      return new MtnMomoProvider({
        channelId: "chn_mtn_zm",
        config: {
          ...mtnMomoFixtures.config,
          base_url: "https://mtn_momo_zm.sandbox.example.com"
        },
        countryCode: "ZM",
        credentials: mtnMomoFixtures.credentials,
        transport
      });
    }
  },
  {
    countryCode: "GH",
    fixtures: telecelCashFixtures,
    name: "telecel_cash",
    numbers: {
      invalidCountry: "+260977123456",
      valid: "+233244123456"
    },
    createProvider(transport) {
      return new TelecelCashProvider({
        channelId: "chn_telecel",
        config: telecelCashFixtures.config,
        countryCode: "GH",
        credentials: telecelCashFixtures.credentials,
        transport
      });
    }
  },
  {
    countryCode: "GH",
    fixtures: atMoneyFixtures,
    name: "at_money",
    numbers: {
      invalidCountry: "+260977123456",
      valid: "+233244123456"
    },
    createProvider(transport) {
      return new AtMoneyProvider({
        channelId: "chn_at",
        config: atMoneyFixtures.config,
        countryCode: "GH",
        credentials: atMoneyFixtures.credentials,
        transport
      });
    }
  },
  {
    countryCode: "ZM",
    fixtures: airtelMoneyFixtures,
    name: "airtel_money",
    numbers: {
      invalidCountry: "+233244123456",
      valid: "+260977123456"
    },
    createProvider(transport) {
      return new AirtelMoneyProvider({
        channelId: "chn_airtel",
        config: airtelMoneyFixtures.config,
        countryCode: "ZM",
        credentials: airtelMoneyFixtures.credentials,
        transport
      });
    }
  },
  {
    countryCode: "ZM",
    fixtures: zamtelMoneyFixtures,
    name: "zamtel_money",
    numbers: {
      invalidCountry: "+233244123456",
      valid: "+260977123456"
    },
    createProvider(transport) {
      return new ZamtelMoneyProvider({
        channelId: "chn_zamtel",
        config: zamtelMoneyFixtures.config,
        countryCode: "ZM",
        credentials: zamtelMoneyFixtures.credentials,
        transport
      });
    }
  }
];

for (const descriptor of descriptors) {
  describe(`${descriptor.name} adapter contract`, () => {
    it("supports success, failure, pending, timeout, callbacks, and phone validation", async () => {
      const transport = new FixtureTransport(descriptor.fixtures);
      const provider = descriptor.createProvider(transport);

      const success = await provider.collect({
        amount: 1500,
        context: {
          mode: "live",
          requestId: "req_success"
        },
        currency: descriptor.countryCode === "ZM" ? "ZMW" : "GHS",
        msisdn: descriptor.numbers.valid,
        reference: descriptor.fixtures.references.success
      });
      expect(success.outcome).toBe("succeeded");
      expect(success.providerRef).toBeTruthy();

      const failure = await provider.collect({
        amount: 1500,
        context: {
          mode: "live",
          requestId: "req_failure"
        },
        currency: descriptor.countryCode === "ZM" ? "ZMW" : "GHS",
        msisdn: descriptor.numbers.valid,
        reference: descriptor.fixtures.references.failure
      });
      expect(failure.outcome).toBe("failed");
      expect(failure.failureCode).toBe("insufficient_funds");

      const pending = await provider.collect({
        amount: 1500,
        context: {
          mode: "live",
          requestId: "req_pending"
        },
        currency: descriptor.countryCode === "ZM" ? "ZMW" : "GHS",
        msisdn: descriptor.numbers.valid,
        reference: descriptor.fixtures.references.pending
      });
      expect(pending.outcome).toBe("accepted");

      const timeout = await provider.collect({
        amount: 1500,
        context: {
          mode: "live",
          requestId: "req_timeout"
        },
        currency: descriptor.countryCode === "ZM" ? "ZMW" : "GHS",
        msisdn: descriptor.numbers.valid,
        reference: descriptor.fixtures.references.timeout
      });
      expect(timeout.outcome).toBe("unknown");

      const pendingStatus = await provider.getStatus(
        String(descriptor.fixtures.status.pending.body.provider_ref)
      );
      expect(pendingStatus.outcome).toBe("accepted");

      const timeoutStatus = await provider.getStatus(
        String(descriptor.fixtures.status.timeout.body.provider_ref)
      );
      expect(timeoutStatus.outcome).toBe("succeeded");

      const lookup = await provider.lookupAccountName?.(descriptor.numbers.valid);
      expect(lookup?.outcome).toBe("succeeded");

      const invalidNumber = await provider.collect({
        amount: 1500,
        context: {
          mode: "live",
          requestId: "req_invalid"
        },
        currency: descriptor.countryCode === "ZM" ? "ZMW" : "GHS",
        msisdn: descriptor.numbers.invalidCountry,
        reference: "fixture_invalid_country"
      });
      expect(invalidNumber.outcome).toBe("failed");
      expect(invalidNumber.failureCode).toBe("invalid_phone_number");

      const duplicateOne = await provider.parseCallback(
        descriptor.fixtures.callback.success.rawBody
      );
      const duplicateTwo = await provider.parseCallback(
        descriptor.fixtures.callback.duplicate.rawBody
      );
      expect(duplicateOne.eventId).toBe(duplicateTwo.eventId);
      expect(duplicateOne.providerRef).toBe(duplicateTwo.providerRef);

      expect(
        provider.verifyCallback({
          headers: descriptor.fixtures.callback.success.headers,
          ip: "127.0.0.1",
          rawBody: descriptor.fixtures.callback.success.rawBody
        })
      ).toBe(true);

      expect(
        provider.verifyCallback({
          headers: descriptor.fixtures.callback.badSignature.headers,
          ip: "127.0.0.1",
          rawBody: descriptor.fixtures.callback.badSignature.rawBody
        })
      ).toBe(false);
    });

    it("caches the OAuth token between requests", async () => {
      const transport = new FixtureTransport(descriptor.fixtures);
      const provider = descriptor.createProvider(transport);

      await provider.collect({
        amount: 1500,
        context: {
          mode: "live",
          requestId: "req_one"
        },
        currency: descriptor.countryCode === "ZM" ? "ZMW" : "GHS",
        msisdn: descriptor.numbers.valid,
        reference: descriptor.fixtures.references.success
      });

      await provider.collect({
        amount: 1500,
        context: {
          mode: "live",
          requestId: "req_two"
        },
        currency: descriptor.countryCode === "ZM" ? "ZMW" : "GHS",
        msisdn: descriptor.numbers.valid,
        reference: descriptor.fixtures.references.pending
      });

      expect(transport.tokenRequests).toHaveLength(1);
    });
  });
}

function asRecord(value: ProviderHttpRequest["body"]): Record<string, unknown> {
  if (!value) {
    return {};
  }

  if (typeof value === "string") {
    return JSON.parse(value) as Record<string, unknown>;
  }

  return value;
}
