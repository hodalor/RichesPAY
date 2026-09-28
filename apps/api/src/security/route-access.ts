import type { HTTPMethods, RouteOptions } from "fastify";

export type RichesPayRouteAuthType =
  | "admin_session"
  | "api_key"
  | "checkout_public_key"
  | "dashboard_session"
  | "provider_callback"
  | "public";

export interface RichesPayRouteAccess {
  auth: RichesPayRouteAuthType;
  explicit_public: boolean;
  requirement: string | null;
}

export interface RichesPayRegisteredRouteAccess {
  access: RichesPayRouteAccess | null;
  method: string;
  url: string;
}

interface RouteAccessMatcher {
  access: RichesPayRouteAccess;
  methods?: readonly string[];
  pattern: RegExp;
}

const routeAccessMatchers: RouteAccessMatcher[] = [
  {
    access: { auth: "public", explicit_public: true, requirement: null },
    methods: ["GET"],
    pattern: /^\/health$/
  },
  {
    access: { auth: "public", explicit_public: true, requirement: null },
    methods: ["GET"],
    pattern: /^\/metrics$/
  },
  {
    access: { auth: "public", explicit_public: true, requirement: null },
    methods: ["GET"],
    pattern: /^\/status$/
  },
  {
    access: { auth: "public", explicit_public: true, requirement: null },
    methods: ["GET"],
    pattern: /^\/v1\/status$/
  },
  {
    access: { auth: "public", explicit_public: true, requirement: null },
    methods: ["GET"],
    pattern: /^\/v1\/openapi\.pdf$/
  },
  {
    access: {
      auth: "provider_callback",
      explicit_public: true,
      requirement: "provider.callback"
    },
    methods: ["POST"],
    pattern: /^\/callbacks\/[^/]+$/
  },
  {
    access: { auth: "public", explicit_public: true, requirement: null },
    methods: ["GET"],
    pattern: /^\/v1\/openapi\.json$/
  },
  {
    access: { auth: "public", explicit_public: true, requirement: null },
    pattern: /^\/v1\/checkout\/payment-links\/[^/]+(?:\/sessions(?:\/[^/]+(?:\/pay)?)?)?$/
  },
  {
    access: {
      auth: "checkout_public_key",
      explicit_public: false,
      requirement: "checkout.public_key"
    },
    pattern: /^\/v1\/checkout\/sessions(?:\/[^/]+(?:\/pay)?)?$/
  },
  {
    access: { auth: "api_key", explicit_public: false, requirement: "read" },
    methods: ["GET"],
    pattern: /^\/v1\/balance$/
  },
  {
    access: { auth: "api_key", explicit_public: false, requirement: "read" },
    methods: ["GET"],
    pattern: /^\/v1\/fees\/quote$/
  },
  {
    access: {
      auth: "api_key",
      explicit_public: false,
      requirement: "collections"
    },
    pattern: /^\/v1\/collections(?:\/.*)?$/
  },
  {
    access: {
      auth: "api_key",
      explicit_public: false,
      requirement: "payouts"
    },
    pattern: /^\/v1\/payouts(?:\/.*)?$/
  },
  {
    access: {
      auth: "api_key",
      explicit_public: false,
      requirement: "payouts"
    },
    pattern: /^\/v1\/payout-batches(?:\/.*)?$/
  },
  {
    access: {
      auth: "api_key",
      explicit_public: false,
      requirement: "payouts"
    },
    methods: ["GET"],
    pattern: /^\/v1\/accounts\/lookup$/
  },
  {
    access: {
      auth: "api_key",
      explicit_public: false,
      requirement: "sms"
    },
    pattern: /^\/v1\/sms(?:\/.*)?$/
  },
  {
    access: {
      auth: "api_key",
      explicit_public: false,
      requirement: "sms"
    },
    pattern: /^\/v1\/otp(?:\/.*)?$/
  },
  {
    access: {
      auth: "api_key",
      explicit_public: false,
      requirement: "airtime"
    },
    pattern: /^\/v1\/airtime(?:\/.*)?$/
  },
  {
    access: { auth: "public", explicit_public: true, requirement: null },
    methods: ["POST"],
    pattern: /^\/dashboard\/v1\/auth\/sign-up$/
  },
  {
    access: { auth: "public", explicit_public: true, requirement: null },
    methods: ["GET"],
    pattern: /^\/dashboard\/v1\/auth\/invitations\/[^/]+$/
  },
  {
    access: {
      auth: "dashboard_session",
      explicit_public: false,
      requirement: "dashboard.authenticated"
    },
    pattern: /^\/dashboard\/v1\/auth(?:\/.*)?$/
  },
  {
    access: {
      auth: "dashboard_session",
      explicit_public: false,
      requirement: "members.read"
    },
    methods: ["GET"],
    pattern: /^\/dashboard\/v1\/team\/members$/
  },
  {
    access: {
      auth: "dashboard_session",
      explicit_public: false,
      requirement: "team.manage"
    },
    pattern: /^\/dashboard\/v1\/team(?:\/.*)?$/
  },
  {
    access: {
      auth: "dashboard_session",
      explicit_public: false,
      requirement: "api_keys.manage"
    },
    pattern: /^\/dashboard\/v1\/api-keys(?:\/.*)?$/
  },
  {
    access: {
      auth: "dashboard_session",
      explicit_public: false,
      requirement: "api_keys.manage"
    },
    methods: ["GET"],
    pattern: /^\/dashboard\/v1\/api-request-logs$/
  },
  {
    access: {
      auth: "dashboard_session",
      explicit_public: false,
      requirement: "api_keys.manage"
    },
    methods: ["GET"],
    pattern: /^\/dashboard\/v1\/events-outbox$/
  },
  {
    access: {
      auth: "dashboard_session",
      explicit_public: false,
      requirement: "webhooks.manage"
    },
    pattern: /^\/dashboard\/v1\/webhooks(?:\/.*)?$/
  },
  {
    access: {
      auth: "dashboard_session",
      explicit_public: false,
      requirement: "payment_links.manage"
    },
    pattern: /^\/dashboard\/v1\/payment-links(?:\/.*)?$/
  },
  {
    access: {
      auth: "dashboard_session",
      explicit_public: false,
      requirement: "payouts.create"
    },
    pattern: /^\/dashboard\/v1\/payouts(?:\/.*)?$/
  },
  {
    access: {
      auth: "dashboard_session",
      explicit_public: false,
      requirement: "settlements.manage"
    },
    pattern: /^\/dashboard\/v1\/(?:settlement-accounts|settlement-settings|withdrawals)(?:\/.*)?$/
  },
  {
    access: {
      auth: "dashboard_session",
      explicit_public: false,
      requirement: "topups.manage"
    },
    pattern: /^\/dashboard\/v1\/topups(?:\/.*)?$/
  },
  {
    access: {
      auth: "dashboard_session",
      explicit_public: false,
      requirement: "sms.manage"
    },
    pattern: /^\/dashboard\/v1\/(?:sms|otp|sender-ids)(?:\/.*)?$/
  },
  {
    access: {
      auth: "dashboard_session",
      explicit_public: false,
      requirement: "airtime.send"
    },
    methods: ["POST"],
    pattern: /^\/dashboard\/v1\/airtime(?:\/.*)?$/
  },
  {
    access: {
      auth: "dashboard_session",
      explicit_public: false,
      requirement: "dashboard.authenticated"
    },
    methods: ["GET"],
    pattern: /^\/dashboard\/v1\/airtime(?:\/.*)?$/
  },
  {
    access: {
      auth: "dashboard_session",
      explicit_public: false,
      requirement: "dashboard.authenticated"
    },
    methods: ["GET"],
    pattern: /^\/dashboard\/v1\/session$/
  },
  {
    access: {
      auth: "dashboard_session",
      explicit_public: false,
      requirement: "dashboard.authenticated"
    },
    pattern: /^\/dashboard\/v1\/.*$/
  },
  {
    access: {
      auth: "admin_session",
      explicit_public: false,
      requirement: "platform_admin"
    },
    pattern: /^\/admin\/v1\/.*$/
  }
];

export function auditRouteAccess(
  routeOptions: Pick<RouteOptions, "method" | "url">
): RichesPayRegisteredRouteAccess[] {
  const methods = Array.isArray(routeOptions.method)
    ? routeOptions.method
    : [routeOptions.method];

  return methods
    .flatMap((method) => normalizeRouteMethod(method))
    .filter((method) => method !== null)
    .map((method) => ({
      access: resolveRouteAccess(method, routeOptions.url),
      method,
      url: normalizeRouteUrl(routeOptions.url)
    }));
}

function resolveRouteAccess(
  method: string,
  url: string
): RichesPayRouteAccess | null {
  const normalizedMethod = normalizeRouteMethod(method);
  if (!normalizedMethod) {
    return null;
  }

  const normalizedUrl = normalizeRouteUrl(url);

  for (const matcher of routeAccessMatchers) {
    if (matcher.methods && !matcher.methods.includes(normalizedMethod)) {
      continue;
    }

    if (matcher.pattern.test(normalizedUrl)) {
      return matcher.access;
    }
  }

  return null;
}

function normalizeRouteMethod(method: HTTPMethods | string): string | null {
  if (method === "HEAD") {
    return "GET";
  }

  if (method === "OPTIONS") {
    return null;
  }

  return String(method).toUpperCase();
}

function normalizeRouteUrl(url: string): string {
  const normalized = url.replace(/\/+/g, "/");
  if (normalized.length > 1 && normalized.endsWith("/")) {
    return normalized.slice(0, -1);
  }

  return normalized;
}
