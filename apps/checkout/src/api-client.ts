import type {
  ApiErrorEnvelope,
  ApiSuccessEnvelope,
  ErrorCode
} from "@richespay/shared";

import { env } from "./env";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly code: ErrorCode,
    readonly status: number,
    readonly field?: string,
    readonly requestId?: string
  ) {
    super(message);
    this.name = "ApiError";
  }
}

function isApiErrorEnvelope(value: unknown): value is ApiErrorEnvelope {
  return (
    typeof value === "object" &&
    value !== null &&
    "error" in value &&
    typeof value.error === "object" &&
    value.error !== null
  );
}

export interface ApiRequestOptions extends Omit<RequestInit, "body"> {
  bearerToken?: string | null;
  body?: BodyInit | Record<string, unknown> | null;
  idempotencyKey?: string | null;
}

export async function apiRequest<T>(
  path: string,
  init: ApiRequestOptions = {}
): Promise<T> {
  const {
    bearerToken,
    body,
    idempotencyKey,
    ...requestInit
  } = init;
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");

  const token = bearerToken ?? env.bearerToken;
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }

  if (idempotencyKey) {
    headers.set("Idempotency-Key", idempotencyKey);
  }

  const requestBody =
    body && typeof body === "object" && !(body instanceof FormData)
      ? JSON.stringify(body)
      : body;

  if (!headers.has("Content-Type") && requestBody) {
    headers.set("Content-Type", "application/json");
  }

  const response = await fetch(new URL(path, env.apiBaseUrl), {
    ...requestInit,
    ...(requestBody !== undefined ? { body: requestBody } : {}),
    headers
  });

  const bodyText = await response.text();
  const parsedBody = bodyText ? (JSON.parse(bodyText) as unknown) : undefined;

  if (isApiErrorEnvelope(parsedBody)) {
    throw new ApiError(
      parsedBody.error.message,
      parsedBody.error.code,
      response.status,
      parsedBody.error.field,
      parsedBody.error.request_id
    );
  }

  if (!response.ok) {
    throw new ApiError(
      "Unexpected API error",
      "internal_error",
      response.status
    );
  }

  if (
    typeof parsedBody !== "object" ||
    parsedBody === null ||
    !("data" in parsedBody)
  ) {
    throw new ApiError("Invalid API response envelope", "internal_error", 500);
  }

  return ((parsedBody as unknown) as ApiSuccessEnvelope<T>).data;
}
