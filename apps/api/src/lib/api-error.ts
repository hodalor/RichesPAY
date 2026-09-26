import { isErrorCode, type ErrorCode } from "@richespay/shared";

export class ApiRouteError extends Error {
  readonly code: ErrorCode;
  readonly field: string | undefined;
  readonly statusCode: number;

  constructor(options: {
    code: ErrorCode;
    field?: string;
    message: string;
    statusCode: number;
  }) {
    super(options.message);
    this.name = "ApiRouteError";
    this.code = options.code;
    this.field = options.field;
    this.statusCode = options.statusCode;
  }
}

export function isApiRouteError(error: unknown): error is ApiRouteError {
  return error instanceof ApiRouteError;
}

export function extractErrorCode(error: unknown): ErrorCode | null {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    isErrorCode(error.code)
  ) {
    return error.code;
  }

  return null;
}
