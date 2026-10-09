import type { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import type { Context } from "hono";
import { type Clock, OriginError, createOrigin } from "./origin.ts";

export const DEFAULT_WINDOW_DAYS = 7;

async function jsonBody(c: Context): Promise<Record<string, unknown>> {
  const body: unknown = await c.req.json().catch(() => null);
  return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}

export function createApp(db: DatabaseSync, options: { clock?: Clock; windowDays?: number } = {}) {
  const origin = createOrigin(db, {
    clock: options.clock ?? (() => new Date()),
    windowDays: options.windowDays ?? DEFAULT_WINDOW_DAYS,
  });
  const app = new Hono();

  app.onError((error, c) => {
    if (error instanceof OriginError) {
      return c.json({ error: { code: error.code, message: error.message } }, error.status);
    }
    console.error(error);
    return c.json({ error: { code: "internal_error", message: "erro interno" } }, 500);
  });

  app.get("/health", (c) => c.json({ ok: true }));

  app.post("/installs/:install_id/opens", async (c) => {
    const result = origin.recordOpen(c.req.param("install_id"), await jsonBody(c));
    return c.json(result, result.install.first_open ? 201 : 200);
  });

  app.post("/signups", async (c) => {
    const result = origin.signup(await jsonBody(c));
    return c.json(result.attribution, result.created ? 201 : 200);
  });

  app.get("/signups/:user_id/attribution", (c) => c.json(origin.attribution(c.req.param("user_id"))));

  return app;
}
