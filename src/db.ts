import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

const SCHEMA = `
-- Uma instalação do app. install_id é gerado pelo app na primeira abertura e guardado no aparelho.
CREATE TABLE IF NOT EXISTS installs (
  install_id TEXT PRIMARY KEY,
  first_opened_at TEXT NOT NULL
);

-- Um toque é um link de atribuição aberto. A chave (instalação, ct_click) impede que o mesmo
-- clique reaberto crie outra origem.
CREATE TABLE IF NOT EXISTS touches (
  id TEXT PRIMARY KEY,
  install_id TEXT NOT NULL REFERENCES installs (install_id),
  click_id TEXT NOT NULL,
  source TEXT NOT NULL,
  ref TEXT NOT NULL,
  url TEXT NOT NULL,
  touched_at TEXT NOT NULL,
  UNIQUE (install_id, click_id)
);

-- A origem decidida fica gravada com o motivo, inclusive quando é orgânica.
CREATE TABLE IF NOT EXISTS signups (
  user_id TEXT PRIMARY KEY,
  install_id TEXT UNIQUE,
  signed_up_at TEXT NOT NULL,
  origin_source TEXT NOT NULL,
  origin_ref TEXT,
  winning_touch_id TEXT,
  reason_code TEXT NOT NULL,
  reason TEXT NOT NULL,
  window_days INTEGER NOT NULL
);
`;

export function openDatabase(path = ":memory:"): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  return db;
}
