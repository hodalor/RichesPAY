import fp from "fastify-plugin";

import {
  assertAdminIpAllowed,
  enforceAdminMfa,
  getClientIp,
  resolvePlatformAdmin
} from "../auth/admin-access";
import { authenticateSupabaseSession } from "../auth/session";
import { ApiRouteError } from "../lib/api-error";

export const adminAuthPlugin = fp(async (app) => {
  app.decorateRequest("authenticatedSession", null);
  app.decorateRequest("platformAdmin", null);

  app.addHook("onRequest", async (request) => {
    const session = await authenticateSupabaseSession(
      app.db,
      {
        anonKey: app.appEnv.SUPABASE_ANON_KEY,
        jwtSecret: app.appEnv.SUPABASE_JWT_SECRET,
        supabaseUrl: app.appEnv.SUPABASE_URL
      },
      request.headers.authorization
    );
    const platformAdmin = await resolvePlatformAdmin(app.db, session.userId);

    if (!platformAdmin || !platformAdmin.active) {
      throw new ApiRouteError({
        code: "unauthorized",
        message: "Active platform admin access is required",
        statusCode: 401
      });
    }

    const clientIp = getClientIp(
      request.headers as Record<string, unknown>,
      request.ip
    );
    assertAdminIpAllowed(clientIp, app.appEnv.ADMIN_IP_ALLOWLIST);
    enforceAdminMfa(session, platformAdmin);

    request.authenticatedSession = session;
    request.platformAdmin = platformAdmin;
  });
});
