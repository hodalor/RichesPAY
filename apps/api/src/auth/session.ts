import { runWithSystemScope, type AppDatabase } from "../db";
import { verifySupabaseJwt, type SupabaseJwtClaims } from "./jwt";

export interface AuthenticatedSession {
  aal: "aal1" | "aal2";
  claims: SupabaseJwtClaims;
  email: string | null;
  userId: string;
}

export async function authenticateSupabaseSession(
  database: AppDatabase,
  jwtSecret: string,
  authorizationHeader: string | undefined
): Promise<AuthenticatedSession> {
  const claims = await verifySupabaseJwt(authorizationHeader, jwtSecret);
  const email =
    claims.email ??
    (await loadUserEmail(database, claims.sub));

  return {
    aal: claims.aal ?? "aal1",
    claims,
    email,
    userId: claims.sub
  };
}

async function loadUserEmail(
  database: AppDatabase,
  userId: string
): Promise<string | null> {
  const user = await runWithSystemScope(
    database,
    "load auth session email",
    async (trx) =>
      trx
        .selectFrom("auth.users")
        .select("email")
        .where("id", "=", userId)
        .executeTakeFirst(),
    { audit: false }
  );

  return user?.email ?? null;
}
