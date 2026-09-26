export type ErrorCode =
  | "validation_error"
  | "internal_error"
  | "unauthorized"
  | "not_found"
  | "rate_limited"
  | "product_not_enabled";

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

const ERROR_CODES = new Set<ErrorCode>([
  "validation_error",
  "internal_error",
  "unauthorized",
  "not_found",
  "rate_limited",
  "product_not_enabled"
]);

export function isErrorCode(value: string): value is ErrorCode {
  return ERROR_CODES.has(value as ErrorCode);
}

export function createApiErrorEnvelope(error: ApiErrorBody): ApiErrorEnvelope {
  return { error };
}
