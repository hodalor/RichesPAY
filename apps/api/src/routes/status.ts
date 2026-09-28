import { z } from "zod";

import { runWithSystemScope } from "../db";
import type { FastifyTypedInstance } from "../types";
import { renderPrometheusMetrics } from "../observability/metrics";

export async function registerObservabilityRoutes(app: FastifyTypedInstance) {
  app.get(
    "/metrics",
    {
      schema: {
        hide: true
      }
    },
    async (request, reply) => {
      const token = app.appEnv.METRICS_TOKEN;
      if (token) {
        const header = request.headers.authorization;
        if (header !== `Bearer ${token}`) {
          return reply.status(401).send({ error: { code: "unauthorized", message: "Metrics token required" } });
        }
      }

      return reply.type("text/plain; version=0.0.4").send(renderPrometheusMetrics());
    }
  );

  app.get(
    "/status",
    {
      schema: {
        hide: true
      }
    },
    async (_request, reply) => {
      const snapshot = await loadStatus(app);
      return reply.type("text/html; charset=utf-8").send(renderStatusPage(snapshot));
    }
  );

  app.get(
    "/v1/status",
    {
      schema: {
        hide: true,
        response: {
          200: z.object({
            data: z.object({
              countries: z.array(
                z.object({
                  channels: z.array(
                    z.object({
                      health: z.string(),
                      id: z.string(),
                      kind: z.string(),
                      network: z.string().nullable(),
                      provider_code: z.string(),
                      status: z.string()
                    })
                  ),
                  code: z.string(),
                  name: z.string()
                })
              ),
              generated_at: z.string()
            })
          })
        }
      }
    },
    async () => ({
      data: await loadStatus(app)
    })
  );
}

async function loadStatus(app: FastifyTypedInstance) {
  const channels = await runWithSystemScope(
    app.db,
    "public status page",
    async (trx) =>
      trx
        .selectFrom("channels")
        .select(["country_code", "health", "id", "kind", "network", "provider_code", "status"])
        .where("mode", "=", "live")
        .orderBy("country_code")
        .orderBy("provider_code")
        .execute(),
    { audit: false }
  ).catch(() => []);

  const grouped = new Map<string, typeof channels>();
  for (const channel of channels) {
    const rows = grouped.get(channel.country_code) ?? [];
    rows.push(channel);
    grouped.set(channel.country_code, rows);
  }

  for (const code of ["GH", "ZM"]) {
    if (!grouped.has(code)) {
      grouped.set(code, []);
    }
  }

  return {
    countries: [...grouped.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([code, rows]) => ({
        channels: rows.map((row) => ({
          health: row.health,
          id: row.id,
          kind: row.kind,
          network: row.network,
          provider_code: row.provider_code,
          status: row.status
        })),
        code,
        name: countryName(code)
      })),
    generated_at: new Date().toISOString()
  };
}

function countryName(code: string) {
  switch (code) {
    case "GH":
      return "Ghana";
    case "ZM":
      return "Zambia";
    default:
      return code;
  }
}

function renderStatusPage(snapshot: Awaited<ReturnType<typeof loadStatus>>) {
  const sections = snapshot.countries
    .map((country) => {
      const rows =
        country.channels.length === 0
          ? "<p>No live channels configured.</p>"
          : `<ul>${country.channels
              .map(
                (channel) =>
                  `<li><strong>${escapeHtml(channel.provider_code)}</strong> ${escapeHtml(channel.network ?? channel.kind)} — ${escapeHtml(channel.health)} / ${escapeHtml(channel.status)}</li>`
              )
              .join("")}</ul>`;
      return `<section><h2>${escapeHtml(country.name)}</h2>${rows}</section>`;
    })
    .join("");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>RichesPay status</title>
    <style>
      body { font-family: Inter, sans-serif; margin: 40px auto; max-width: 720px; color: #1f2933; }
      h1 { color: #f97316; }
    </style>
  </head>
  <body>
    <h1>RichesPay status</h1>
    <p>Updated ${escapeHtml(snapshot.generated_at)}</p>
    ${sections}
  </body>
</html>`;
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
