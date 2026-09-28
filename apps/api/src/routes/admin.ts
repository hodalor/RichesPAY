import { z } from "zod";

import { registerAdminPortalRoutes } from "../admin/portal-routes";
import { registerAirtimeAdminRoutes } from "../airtime";
import { adminAuthPlugin } from "../plugins/admin-auth";
import { registerComplianceAdminRoutes } from "../compliance";
import { registerPricingAdminRoutes } from "../pricing/admin-routes";
import { registerProviderAdminRoutes } from "../providers/admin-routes";
import { registerReconciliationAdminRoutes } from "../reconciliation";
import { registerSmsAdminRoutes } from "../sms";
import { registerTopupAdminRoutes } from "../topups";

import type { FastifyTypedInstance } from "../types";

export async function registerAdminRoutes(app: FastifyTypedInstance) {
  await app.register(async (protectedApp) => {
    await protectedApp.register(adminAuthPlugin);
    await registerAdminPortalRoutes(protectedApp);
    await registerComplianceAdminRoutes(protectedApp);
    await registerPricingAdminRoutes(protectedApp);
    await registerProviderAdminRoutes(protectedApp);
    await registerReconciliationAdminRoutes(protectedApp);
    await registerSmsAdminRoutes(protectedApp);
    await registerAirtimeAdminRoutes(protectedApp);
    await registerTopupAdminRoutes(protectedApp);

    protectedApp.get(
      "/session",
      {
        schema: {
          response: {
            200: z.object({
              data: z.object({
                email: z.string().nullable(),
                role: z.enum([
                  "super_admin",
                  "compliance",
                  "operations",
                  "finance",
                  "support"
                ]),
                user_id: z.string()
              })
            })
          }
        }
      },
      async (request) => ({
        data: {
          email: request.authenticatedSession?.email ?? null,
          role: request.platformAdmin!.role,
          user_id: request.platformAdmin!.userId
        }
      })
    );
  });
}
