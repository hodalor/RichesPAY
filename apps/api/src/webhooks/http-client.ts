import https from "node:https";
import net from "node:net";

import {
  defaultWebhookLookup,
  resolveWebhookTargetAddress,
  type WebhookLookupFn
} from "./security";

export interface WebhookHttpResponse {
  body: string;
  durationMs: number;
  statusCode: number;
}

export class WebhookHttpClient {
  #lookup: WebhookLookupFn;

  constructor(lookup: WebhookLookupFn = defaultWebhookLookup) {
    this.#lookup = lookup;
  }

  async postJson(input: {
    body: string;
    headers: Record<string, string>;
    url: string;
  }): Promise<WebhookHttpResponse> {
    const target = new URL(input.url);
    const resolvedAddress = await resolveWebhookTargetAddress(target, this.#lookup);
    const startedAt = Date.now();

    return new Promise((resolve, reject) => {
      const request = https.request(
        {
          headers: {
            "content-length": Buffer.byteLength(input.body).toString(),
            "content-type": "application/json",
            ...input.headers
          },
          hostname: target.hostname,
          lookup: (_hostname, _options, callback) => {
            callback(null, resolvedAddress, net.isIP(resolvedAddress));
          },
          method: "POST",
          path: `${target.pathname}${target.search}`,
          port: target.port ? Number(target.port) : 443,
          protocol: "https:",
          servername: target.hostname,
          timeout: 10_000
        },
        (response) => {
          const chunks: Buffer[] = [];

          response.on("data", (chunk) => {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          });

          response.on("end", () => {
            resolve({
              body: Buffer.concat(chunks).toString("utf8"),
              durationMs: Math.max(Date.now() - startedAt, 0),
              statusCode: response.statusCode ?? 0
            });
          });
        }
      );

      request.on("error", reject);
      request.on("timeout", () => {
        request.destroy(Object.assign(new Error("Webhook request timed out"), { code: "ETIMEDOUT" }));
      });
      request.write(input.body);
      request.end();
    });
  }
}
