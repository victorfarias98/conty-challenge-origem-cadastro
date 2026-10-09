import { serve } from "@hono/node-server";
import { DEFAULT_WINDOW_DAYS, createApp } from "./app.ts";
import { openDatabase } from "./db.ts";

const db = openDatabase(process.env.DB_PATH ?? "data/origem.sqlite");
const port = Number(process.env.PORT ?? 3006);
const windowDays = Number(process.env.ATTRIBUTION_WINDOW_DAYS ?? DEFAULT_WINDOW_DAYS);

serve({ fetch: createApp(db, { windowDays }).fetch, port }, (info) => {
  console.log(`origem do cadastro em http://127.0.0.1:${info.port} (janela de ${windowDays} dias)`);
});
