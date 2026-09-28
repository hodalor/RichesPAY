import type {
  ApiErrorEnvelope,
  ApiSuccessEnvelope,
  ErrorCode
} from "@richespay/shared";

import { env } from "./env";
import { supabase } from "./supabase";

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

export interface ApiRequestOptions extends RequestInit {
  accessToken?: string | null;
  merchantId?: string | null;
  retriedAfterRefresh?: boolean;
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

const requestTimeoutMs = 8_000;

export async function apiRequest<T>(
  path: string,
  init: ApiRequestOptions = {}
): Promise<T> {
  const { accessToken, merchantId, retriedAfterRefresh, ...requestInit } = init;
  const headers = new Headers(requestInit.headers);
  headers.set("Accept", "application/json");

  if (!headers.has("Content-Type") && requestInit.body) {
    headers.set("Content-Type", "application/json");
  }

  if (accessToken) {
    headers.set("Authorization", `Bearer ${accessToken}`);
  }

  if (merchantId) {
    headers.set("X-Merchant-Id", merchantId);
  }

  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), requestTimeoutMs);
  let response: Response;

  try {
    response = await fetch(new URL(path, env.apiBaseUrl), {
      ...requestInit,
      headers,
      signal: requestInit.signal ?? controller.signal
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new ApiError(
        "The API did not respond in time. Check that it is running, then try again.",
        "internal_error",
        0
      );
    }

    throw new ApiError(
      "Cannot reach the API. Start it, then try again.",
      "internal_error",
      0
    );
  } finally {
    window.clearTimeout(timeout);
  }

  if (response.status === 401 && accessToken && !retriedAfterRefresh) {
    const refreshed = await supabase.auth.refreshSession();
    const nextToken = refreshed.data.session?.access_token;

    if (nextToken) {
      return apiRequest(path, {
        ...init,
        accessToken: nextToken,
        retriedAfterRefresh: true
      });
    }
  }

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
