import http from "node:http";
import https from "node:https";
import { URL } from "node:url";

import { newId } from "@richespay/shared";

import { runWithSystemScope } from "../db";
import type { AppDatabase } from "../db";
import { redactJsonValue } from "../lib/redaction";
import type {
  ProviderHttpRequest,
  ProviderHttpResponse,
  ProviderHttpTransport
} from "./types";

interface RequestInput extends ProviderHttpRequest {
  mtls?: {
    ca?: string;
    cert: string;
    key: string;
    passphrase?: string;
  };
  retrySafeReads?: boolean;
  timeoutMs?: number;
  url: string;
}

export class HttpProviderClient implements ProviderHttpTransport {
  #database: AppDatabase;

  constructor(database: AppDatabase) {
    this.#database = database;
  }

  async request(input: RequestInput): Promise<ProviderHttpResponse> {
    const startedAt = Date.now();
    const timeoutMs = input.timeoutMs ?? 10_000;
    const attempts = input.retrySafeReads && (input.method === "GET" || input.method === "HEAD")
      ? 2
      : 1;

    let lastError: unknown;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const response = await this.#performRequest({
          ...input,
          timeoutMs
        });

        await this.#log({
          channelId: input.channelId,
          durationMs: Date.now() - startedAt,
          method: input.method,
          path: new URL(input.url).pathname,
          requestBody: input.body,
          responseBody: response.body,
          status: "ok",
          statusCode: response.statusCode
        });

        return response;
      } catch (error) {
        lastError = error;
        const code =
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          typeof error.code === "string"
            ? error.code
            : "error";

        await this.#log({
          channelId: input.channelId,
          durationMs: Date.now() - startedAt,
          method: input.method,
          path: new URL(input.url).pathname,
          requestBody: input.body,
          responseBody: { error_code: code },
          status: "error",
          statusCode: null
        });
      }
    }

    throw lastError;
  }

  async #log(input: {
    channelId: string;
    durationMs: number;
    method: string;
    path: string;
    requestBody?: unknown;
    responseBody?: unknown;
    status: string;
    statusCode: number | null;
  }) {
    await runWithSystemScope(
      this.#database,
      "log provider api call",
      async (trx) => {
        await trx
          .insertInto("provider_api_logs")
          .values({
            channel_id: input.channelId,
            created_at: new Date(),
            duration_ms: Math.max(input.durationMs, 0),
            id: newId("log_"),
            method: input.method,
            path: input.path,
            request_body: redactJsonValue(input.requestBody),
            response_body: redactJsonValue(input.responseBody),
            status: input.status,
            status_code: input.statusCode
          })
          .execute();
      },
      { audit: false }
    );
  }

  #performRequest(input: RequestInput & { timeoutMs: number }): Promise<ProviderHttpResponse> {
    return new Promise((resolve, reject) => {
      const target = new URL(input.url);
      const isHttps = target.protocol === "https:";
      const body =
        typeof input.body === "string"
          ? input.body
          : input.body
            ? JSON.stringify(input.body)
            : undefined;

      const agent = isHttps && input.mtls
        ? new https.Agent({
            ca: input.mtls.ca,
            cert: input.mtls.cert,
            key: input.mtls.key,
            passphrase: input.mtls.passphrase
          })
        : undefined;

      const request = (isHttps ? https : http).request(
        target,
        {
          agent,
          headers: {
            ...(body ? { "content-type": "application/json" } : {}),
            ...input.headers
          },
          method: input.method,
          timeout: input.timeoutMs
        },
        (response) => {
          const chunks: Buffer[] = [];

          response.on("data", (chunk) => {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          });

          response.on("end", () => {
            resolve({
              body: Buffer.concat(chunks).toString("utf8"),
              headers: response.headers,
              statusCode: response.statusCode ?? 0
            });
          });
        }
      );

      request.on("error", reject);
      request.on("timeout", () => {
        request.destroy(Object.assign(new Error("Request timed out"), { code: "ETIMEDOUT" }));
      });

      if (body) {
        request.write(body);
      }

      request.end();
    });
  }
}
