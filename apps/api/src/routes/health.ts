import { z } from "zod";

import type { FastifyTypedInstance } from "../types";

const HEALTH_RESPONSE_SCHEMA = z.object({
  data: z.object({
    status: z.literal("ok")
  })
});

export async function registerHealthRoutes(app: FastifyTypedInstance) {
  app.get(
    "/health",
    {
      schema: {
        tags: ["system"],
        response: {
          200: HEALTH_RESPONSE_SCHEMA
        }
      }
    },
    async () => {
      return {
        data: {
          status: "ok" as const
        }
      };
    }
  );
}
