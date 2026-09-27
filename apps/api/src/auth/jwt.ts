import { createRemoteJWKSet, decodeProtectedHeader, jwtVerify, type JWTPayload } from "jose";

import { ApiRouteError } from "../lib/api-error";

export interface SupabaseJwtClaims extends JWTPayload {
  aal?: "aal1" | "aal2";
  email?: string;
  role?: string;
  session_id?: string;
  sub: string;
}

export interface SupabaseJwtConfig {
  anonKey?: string;
  jwtSecret: string;
  supabaseUrl?: string;
}

const jwksByUrl = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function getBearerToken(headerValue: string | undefined): string {
  if (!headerValue) {
    throw new ApiRouteError({
      code: "unauthorized",
      message: "Authorization header is required",
      statusCode: 401
    });
  }

  const [scheme, token] = headerValue.split(" ");
  if (scheme !== "Bearer" || !token) {
    throw new ApiRouteError({
      code: "unauthorized",
      message: "Authorization header must use Bearer tokens",
      statusCode: 401
    });
  }

  return token;
}

function remoteJwks(supabaseUrl: string, anonKey: string | undefined) {
  const cached = jwksByUrl.get(supabaseUrl);
  if (cached) {
    return cached;
  }

  const jwks = createRemoteJWKSet(new URL(`${supabaseUrl}/auth/v1/.well-known/jwks.json`), {
    ...(anonKey
      ? {
          headers: {
            apikey: anonKey
          }
        }
      : {})
  });
  jwksByUrl.set(supabaseUrl, jwks);
  return jwks;
}

export async function verifySupabaseJwt(
  authorizationHeader: string | undefined,
  config: string | SupabaseJwtConfig
): Promise<SupabaseJwtClaims> {
  const token = getBearerToken(authorizationHeader);
  const jwtConfig: SupabaseJwtConfig =
    typeof config === "string" ? { jwtSecret: config } : config;

  try {
    const header = decodeProtectedHeader(token);
    const key =
      header.alg === "HS256" || !jwtConfig.supabaseUrl
        ? new TextEncoder().encode(jwtConfig.jwtSecret)
        : remoteJwks(jwtConfig.supabaseUrl, jwtConfig.anonKey);

    const { payload } = await jwtVerify(token, key);

    if (!payload.sub) {
      throw new ApiRouteError({
        code: "unauthorized",
        message: "Supabase token is missing a subject",
        statusCode: 401
      });
    }

    return payload as SupabaseJwtClaims;
  } catch (error) {
    if (error instanceof ApiRouteError) {
      throw error;
    }

    throw new ApiRouteError({
      code: "unauthorized",
      message: "Invalid Supabase session token",
      statusCode: 401
    });
  }
}
