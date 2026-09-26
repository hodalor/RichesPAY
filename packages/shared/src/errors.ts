export interface ErrorDefinition {
  message: string;
  status: number;
}

export const ERROR_CATALOG = {
  amount_too_large: {
    message: "The amount is above the allowed limit.",
    status: 400
  },
  amount_too_small: {
    message: "The amount is below the minimum allowed value.",
    status: 400
  },
  authentication_failed: {
    message: "API authentication failed.",
    status: 401
  },
  channel_unavailable: {
    message: "The requested processing channel is currently unavailable.",
    status: 503
  },
  collections_frozen: {
    message: "Collections are frozen for this merchant.",
    status: 403
  },
  forbidden: {
    message: "You do not have access to this resource.",
    status: 403
  },
  idempotency_conflict: {
    message: "This idempotency key was already used with a different request body.",
    status: 409
  },
  insufficient_funds: {
    message: "The account does not have enough funds for this operation.",
    status: 409
  },
  internal_error: {
    message: "Internal server error.",
    status: 500
  },
  invalid_phone_number: {
    message: "The phone number is invalid.",
    status: 400
  },
  ip_not_allowed: {
    message: "This IP address is not allowed.",
    status: 403
  },
  merchant_suspended: {
    message: "The merchant account is suspended.",
    status: 403
  },
  mfa_required: {
    message: "A multi-factor authentication step is required.",
    status: 403
  },
  not_found: {
    message: "The requested resource was not found.",
    status: 404
  },
  payouts_frozen: {
    message: "Payouts are frozen for this merchant.",
    status: 403
  },
  permission_denied: {
    message: "The API key does not have permission to perform this action.",
    status: 403
  },
  product_not_enabled: {
    message: "This product is not enabled for the merchant.",
    status: 403
  },
  provider_error: {
    message: "The upstream provider returned an error.",
    status: 502
  },
  rate_limited: {
    message: "Too many requests were made too quickly.",
    status: 429
  },
  request_in_progress: {
    message: "A request with this idempotency key is still being processed.",
    status: 409
  },
  unauthorized: {
    message: "You must authenticate to access this resource.",
    status: 401
  },
  unsupported_currency: {
    message: "This currency is not supported for the requested operation.",
    status: 400
  },
  validation_error: {
    message: "One or more fields failed validation.",
    status: 400
  }
} as const satisfies Record<string, ErrorDefinition>;

export type ErrorCode = keyof typeof ERROR_CATALOG;

export interface ApiErrorBody {
  code: ErrorCode;
  message: string;
  field?: string;
  request_id?: string;
}

export interface ApiErrorEnvelope {
  error: ApiErrorBody;
}

export interface ApiSuccessEnvelope<T> {
  data: T;
  meta?: Record<string, unknown>;
}

const ERROR_CODES = new Set<ErrorCode>(
  Object.keys(ERROR_CATALOG) as ErrorCode[]
);

export function getErrorDefinition(code: ErrorCode): ErrorDefinition {
  return ERROR_CATALOG[code];
}

export function isErrorCode(value: string): value is ErrorCode {
  return ERROR_CODES.has(value as ErrorCode);
}

export function createApiErrorEnvelope(error: ApiErrorBody): ApiErrorEnvelope {
  return { error };
}
