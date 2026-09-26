import { createHmac } from "node:crypto";

import type {
  PlaceholderMobileMoneyConfig,
  PlaceholderMobileMoneyCredentials
} from "./base";
import type { OAuthTokenPayload } from "./oauth";

export interface MobileMoneyFixtureResponse {
  body: Record<string, unknown>;
  statusCode: number;
}

export interface MobileMoneyCallbackFixture {
  headers: Record<string, string>;
  rawBody: string;
}

export interface MobileMoneyAdapterFixtures {
  callback: {
    badSignature: MobileMoneyCallbackFixture;
    duplicate: MobileMoneyCallbackFixture;
    success: MobileMoneyCallbackFixture;
  };
  collect: {
    failure: MobileMoneyFixtureResponse;
    pending: MobileMoneyFixtureResponse;
    success: MobileMoneyFixtureResponse;
    timeout: {
      code: string;
    };
  };
  config: PlaceholderMobileMoneyConfig;
  credentials: PlaceholderMobileMoneyCredentials;
  lookup: {
    success: MobileMoneyFixtureResponse;
  };
  references: {
    failure: string;
    pending: string;
    success: string;
    timeout: string;
  };
  status: {
    pending: MobileMoneyFixtureResponse;
    timeout: MobileMoneyFixtureResponse;
  };
  token: OAuthTokenPayload;
}

export function createPlaceholderMobileMoneyFixtures(input: {
  callbackSignatureHeader: string;
  countryCode: "GH" | "ZM";
  providerCode: string;
  providerStatuses: {
    failure: string;
    pending: string;
    success: string;
  };
}): MobileMoneyAdapterFixtures {
  const callbackSecret = `${input.providerCode}_callback_secret`;
  const callbackBody = {
    event_id: `${input.providerCode}_callback_1`,
    event_type: "collection.updated",
    provider_ref: `${input.providerCode}_success_ref`,
    resource_id: "col_fixture_success",
    resource_type: "collection",
    status: input.providerStatuses.success
  };
  const rawCallbackBody = JSON.stringify(callbackBody);
  const signature = createHmac("sha256", callbackSecret)
    .update(rawCallbackBody)
    .digest("hex");

  return {
    callback: {
      badSignature: {
        headers: {
          [input.callbackSignatureHeader]: "bad-signature"
        },
        rawBody: rawCallbackBody
      },
      duplicate: {
        headers: {
          [input.callbackSignatureHeader]: signature
        },
        rawBody: rawCallbackBody
      },
      success: {
        headers: {
          [input.callbackSignatureHeader]: signature
        },
        rawBody: rawCallbackBody
      }
    },
    collect: {
      failure: {
        body: {
          error_code: "INSUFFICIENT_FUNDS",
          provider_ref: `${input.providerCode}_failure_ref`,
          status: input.providerStatuses.failure
        },
        statusCode: 200
      },
      pending: {
        body: {
          provider_ref: `${input.providerCode}_pending_ref`,
          status: input.providerStatuses.pending
        },
        statusCode: 200
      },
      success: {
        body: {
          provider_ref: `${input.providerCode}_success_ref`,
          status: input.providerStatuses.success
        },
        statusCode: 200
      },
      timeout: {
        code: "ETIMEDOUT"
      }
    },
    config: {
      base_url: `https://${input.providerCode}.sandbox.example.com`,
      callback_ip_allowlist: ["127.0.0.1/32"],
      callback_secret: callbackSecret,
      health_path: "/health",
      lookup_path: "/accounts/name",
      payout_path: "/transfers",
      request_to_pay_path: "/request-to-pay",
      status_path: "/transactions/{provider_ref}",
      timeout_ms: 5000,
      token_path: "/oauth/token",
      token_scope: `${input.providerCode}.payments`
    },
    credentials: {
      api_key: `${input.providerCode}_api_key`,
      callback_secret: callbackSecret,
      client_id: `${input.providerCode}_client_id`,
      client_secret: `${input.providerCode}_client_secret`,
      merchant_id: `${input.providerCode}_merchant`,
      subscription_key: `${input.providerCode}_subscription`
    },
    lookup: {
      success: {
        body: {
          account_name: "Fixture User",
          provider_ref: `${input.providerCode}_lookup_ref`,
          status: input.providerStatuses.success
        },
        statusCode: 200
      }
    },
    references: {
      failure: "fixture_failure",
      pending: "fixture_pending",
      success: "fixture_success",
      timeout: "fixture_timeout"
    },
    status: {
      pending: {
        body: {
          provider_ref: `${input.providerCode}_pending_ref`,
          status: input.providerStatuses.pending
        },
        statusCode: 200
      },
      timeout: {
        body: {
          provider_ref: `${input.providerCode}_timeout_ref`,
          status: input.providerStatuses.success
        },
        statusCode: 200
      }
    },
    token: {
      access_token: `${input.providerCode}_access_token`,
      expires_in: 3600,
      token_type: "Bearer"
    }
  };
}
