import { randomBytes } from "node:crypto";

import type { AppEnv } from "../env";
import { scrubPii } from "./pii";

interface SpanState {
  spanId: string;
  startMs: number;
  traceId: string;
}

export function recordCompletedSpan(
  env: Pick<AppEnv, "APP_ENV" | "OTEL_EXPORTER_OTLP_ENDPOINT" | "OTEL_SERVICE_NAME">,
  name: string,
  durationMs: number,
  attributes: Record<string, string>
) {
  const endMs = Date.now();
  void exportSpan(
    env,
    name,
    {
      spanId: randomBytes(8).toString("hex"),
      startMs: endMs - durationMs,
      traceId: randomBytes(16).toString("hex")
    },
    attributes
  );
}

async function exportSpan(
  env: Pick<AppEnv, "APP_ENV" | "OTEL_EXPORTER_OTLP_ENDPOINT" | "OTEL_SERVICE_NAME">,
  name: string,
  span: SpanState,
  attributes: Record<string, string>
) {
  if (!env.OTEL_EXPORTER_OTLP_ENDPOINT || env.APP_ENV === "test") {
    return;
  }

  const endMs = Date.now();
  const safeAttributes = scrubPii(attributes) as Record<string, string>;
  const body = {
    resourceSpans: [
      {
        resource: {
          attributes: [
            { key: "service.name", value: { stringValue: env.OTEL_SERVICE_NAME ?? "richespay-api" } }
          ]
        },
        scopeSpans: [
          {
            spans: [
              {
                attributes: Object.entries(safeAttributes).map(([key, value]) => ({
                  key,
                  value: { stringValue: String(value) }
                })),
                endTimeUnixNano: String(endMs * 1_000_000),
                name,
                spanId: span.spanId,
                startTimeUnixNano: String(span.startMs * 1_000_000),
                traceId: span.traceId
              }
            ]
          }
        ]
      }
    ]
  };

  await fetch(new URL("/v1/traces", env.OTEL_EXPORTER_OTLP_ENDPOINT), {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "POST"
  }).catch(() => undefined);
}
