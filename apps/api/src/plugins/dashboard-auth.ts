import fp from "fastify-plugin";

import type { MerchantPermission } from "@richespay/shared";

import {
  assertDashboardPermission,
  enforceDashboardMfa,
  getDashboardPermissions,
  resolveDashboardMembership,
  runInDashboardScope
} from "../auth/dashboard-access";
import { authenticateSupabaseSession } from "../auth/session";
import { ApiRouteError } from "../lib/api-error";

export const dashboardAuthPlugin = fp(async (app) => {
  app.decorateRequest("authenticatedSession", null);
  app.decorateRequest("dashboardMembership", null);
  app.decorateRequest("dashboardPermissions", null);
  app.decorateRequest("assertDashboardPermission", function assertPermission(
    permission: MerchantPermission
  ) {
    if (!this.dashboardMembership) {
      throw new ApiRouteError({
        code: "unauthorized",
        message: "Dashboard membership context is missing",
        statusCode: 401
      });
    }

    assertDashboardPermission(this.dashboardMembership, permission);
  });
  app.decorateRequest("withDashboardScope", function withDashboardScope(fn) {
    if (!this.dashboardMembership) {
      throw new ApiRouteError({
        code: "unauthorized",
        message: "Dashboard membership context is missing",
        statusCode: 401
      });
    }

    return runInDashboardScope(app.db, this.dashboardMembership, fn);
  });

  app.addHook("onRequest", async (request) => {
    const merchantId = request.headers["x-merchant-id"];
    if (typeof merchantId !== "string" || merchantId.trim() === "") {
      throw new ApiRouteError({
        code: "unauthorized",
        field: "x-merchant-id",
        message: "X-Merchant-Id is required",
        statusCode: 401
      });
    }

    const session = await authenticateSupabaseSession(
      app.db,
      app.appEnv.SUPABASE_JWT_SECRET,
      request.headers.authorization
    );
    const membership = await resolveDashboardMembership(
      app.db,
      session.userId,
      merchantId
    );

    if (!membership) {
      throw new ApiRouteError({
        code: "unauthorized",
        message: "No membership exists for this merchant",
        statusCode: 401
      });
    }

    enforceDashboardMfa(session, membership);

    request.authenticatedSession = session;
    request.dashboardMembership = membership;
    request.dashboardPermissions = getDashboardPermissions(membership.role);
  });
});
