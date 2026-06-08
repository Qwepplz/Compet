import type { ServerOptions } from "node:https";
import Fastify from "fastify";
import websocket from "@fastify/websocket";
import { ZodError } from "zod";
import { HttpError } from "../api/httpErrors.js";
import { installApiRateLimit } from "../api/rateLimit.js";
import { registerRoutes, type RouteDeps } from "../api/routes.js";
import type { PresenceService } from "../presence/presenceService.js";
import type { RealtimeEventBus } from "../realtime/eventBus.js";
import { registerWebSocket } from "../realtime/registerWebSocket.js";

export interface CreateServerOptions extends RouteDeps {
  https?: ServerOptions;
  events?: RealtimeEventBus;
  presence?: PresenceService;
}

export async function createServer(options: CreateServerOptions) {
  const fastifyOptions = options.https ? { logger: false, https: options.https } : { logger: false };
  const app = Fastify(fastifyOptions as any);
  await app.register(websocket);
  installApiRateLimit(app);
  await registerRoutes(app, options);
  await registerWebSocket(app, options);
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof HttpError) {
      reply.status(error.statusCode).send({ error: { code: error.code, message: error.message } });
      return;
    }
    if (error instanceof ZodError) {
      reply.status(400).send({ error: { code: "bad_request", message: "Invalid request" } });
      return;
    }
    reply.status(500).send({ error: { code: "internal_error", message: "Internal server error" } });
  });
  return app;
}
