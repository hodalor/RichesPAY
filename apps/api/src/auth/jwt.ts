import { jwtVerify, type JWTPayload } from "jose";

import { ApiRouteError } from "../lib/api-error";

export interface SupabaseJwtClaims extends JWTPayload {
  aal?: "aal1" | "aal2";
  email?: string;
  role?: string;
  session_id?: string;
  sub: string;
}

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

export async function verifySupabaseJwt(
  authorizationHeader: string | undefined,
  jwtSecret: string
): Promise<SupabaseJwtClaims> {
  const token = getBearerToken(authorizationHeader);

  try {
    const { payload } = await jwtVerify(
      token,
      new TextEncoder().encode(jwtSecret)
    );

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
