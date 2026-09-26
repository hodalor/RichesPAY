import { z } from "zod";

const THIRTY_TWO_BYTE_BASE64 = z.string().refine(
  (value) => {
    try {
      return Buffer.from(value, "base64").byteLength === 32;
    } catch {
      return false;
    }
  },
  {
    message: "ENCRYPTION_KEY must decode to exactly 32 bytes in base64"
  }
);

const ENV_SCHEMA = z.object({
  APP_ENV: z.enum(["development", "test", "production"]),
  PORT: z.coerce.number().int().min(1).max(65535),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  SUPABASE_URL: z.string().url("SUPABASE_URL must be a valid URL"),
  SUPABASE_ANON_KEY: z.string().min(1, "SUPABASE_ANON_KEY is required"),
  SUPABASE_SERVICE_ROLE_KEY: z
    .string()
    .min(1, "SUPABASE_SERVICE_ROLE_KEY is required"),
  SUPABASE_JWT_SECRET: z.string().min(1, "SUPABASE_JWT_SECRET is required"),
  REDIS_URL: z.string().url("REDIS_URL must be a valid URL"),
  ENCRYPTION_KEY: THIRTY_TWO_BYTE_BASE64,
  DASHBOARD_ORIGIN: z.string().url("DASHBOARD_ORIGIN must be a valid URL"),
  ADMIN_ORIGIN: z.string().url("ADMIN_ORIGIN must be a valid URL"),
  CHECKOUT_ORIGIN: z.string().url("CHECKOUT_ORIGIN must be a valid URL"),
  ADMIN_IP_ALLOWLIST: z
    .string()
    .min(1, "ADMIN_IP_ALLOWLIST is required")
    .transform((value) =>
      value
        .split(",")
        .map((item) => item.trim())
        .filter((item) => item.length > 0)
    )
});

export type AppEnv = z.infer<typeof ENV_SCHEMA>;

export function loadEnv(rawEnv: NodeJS.ProcessEnv): AppEnv {
  const parsed = ENV_SCHEMA.safeParse(rawEnv);

  if (parsed.success) {
    return parsed.data;
  }

  const message = parsed.error.issues
    .map((issue) => {
      const path = issue.path.join(".") || "env";
      return `- ${path}: ${issue.message}`;
    })
    .join("\n");

  throw new Error(`Invalid API environment configuration:\n${message}`);
}
