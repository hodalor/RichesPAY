import fp from "fastify-plugin";

export const requestIdPlugin = fp(async (app) => {
  app.addHook("onSend", async (request, reply, payload) => {
    reply.header("X-Request-Id", request.id);
    return payload;
  });
});
