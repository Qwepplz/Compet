import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { tooManyRequests } from "./httpErrors.js";

const WINDOW_MS = 60_000;
const DEFAULT_LIMIT = 120;
const REALTIME_EVENTS_LIMIT = 90;
const WEBSOCKET_LIMIT = 30;

type Bucket = { count: number; resetAt: number };

export function installApiRateLimit(app: FastifyInstance<any, any, any, any, any>): void {
  const buckets = new Map<string, Bucket>();

  app.addHook("preHandler", (request, _reply, done) => {
    const route = routeKey(request);
    const limit = limitForRoute(route);
    const key = `${request.method}:${route}:${clientKey(request)}`;
    const now = Date.now();
    const bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + WINDOW_MS });
      done();
      return;
    }
    if (bucket.count >= limit) {
      done(tooManyRequests("Rate limit exceeded"));
      return;
    }
    bucket.count += 1;
    done();
  });
}

function routeKey(request: FastifyRequest): string {
  return request.routeOptions.url ?? request.url.split("?", 1)[0] ?? request.url;
}

function limitForRoute(route: string): number {
  if (route === "/realtime/events") return REALTIME_EVENTS_LIMIT;
  if (route === "/ws") return WEBSOCKET_LIMIT;
  return DEFAULT_LIMIT;
}

function clientKey(request: FastifyRequest): string {
  const header = request.headers.authorization;
  if (header?.startsWith("Bearer ")) return header;
  return request.ip;
}
