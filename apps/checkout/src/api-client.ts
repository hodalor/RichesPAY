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

export async function apiRequest<T>(
  path: string,
  init: RequestInit = {}
): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");

  if (!headers.has("Content-Type") && init.body) {
    headers.set("Content-Type", "application/json");
  }

  if (env.bearerToken) {
    headers.set("Authorization", `Bearer ${env.bearerToken}`);
  }

  const response = await fetch(new URL(path, env.apiBaseUrl), {
    ...init,
    headers
  });

  const bodyText = await response.text();
  const body = bodyText ? (JSON.parse(bodyText) as unknown) : undefined;

  if (isApiErrorEnvelope(body)) {
    throw new ApiError(
      body.error.message,
      body.error.code,
      response.status,
      body.error.field,
      body.error.request_id
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
    typeof body !== "object" ||
    body === null ||
    !("data" in body)
  ) {
    throw new ApiError("Invalid API response envelope", "internal_error", 500);
  }

  return (body as ApiSuccessEnvelope<T>).data;
}
