import type { AppEnv } from "../env";
import { scrubPii } from "./pii";

export async function captureSentryError(
  env: Pick<AppEnv, "APP_ENV" | "DEPLOY_ENV" | "SENTRY_DSN">,
  error: unknown
) {
  if (!env.SENTRY_DSN || env.APP_ENV === "test") {
    return;
  }

  const parsed = parseDsn(env.SENTRY_DSN);
  if (!parsed) {
    return;
  }

  const message = error instanceof Error ? error.message : "Unknown error";
  const payload = scrubPii({
    environment: env.DEPLOY_ENV ?? env.APP_ENV,
    message
  });

  await fetch(`${parsed.storeUrl}`, {
    body: JSON.stringify({
      extra: payload,
      message: String((payload as { message?: string }).message ?? "error")
    }),
    headers: {
      "content-type": "application/json",
      "x-sentry-auth": `Sentry sentry_version=7, sentry_key=${parsed.key}`
    },
    method: "POST"
  }).catch(() => undefined);
}

function parseDsn(dsn: string) {
  try {
    const url = new URL(dsn);
    const projectId = url.pathname.replace(/^\//, "");
    const key = url.username;
    if (!projectId || !key) {
      return null;
    }

    return {
      key,
      storeUrl: `${url.protocol}//${url.host}/api/${projectId}/store/`
    };
  } catch {
    return null;
  }
}
