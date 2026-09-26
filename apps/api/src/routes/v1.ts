import { z } from "zod";

import type { FastifyTypedInstance } from "../types";

export async function registerV1Routes(app: FastifyTypedInstance) {
  app.get(
    "/openapi.json",
    {
      schema: {
        hide: true,
        response: {
          200: z.unknown()
        }
      }
    },
    async () => app.swagger()
  );
}
