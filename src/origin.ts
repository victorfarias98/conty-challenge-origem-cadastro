import type { DatabaseSync } from "node:sqlite";
import { type Decision, type Touch, decideOrigin } from "./attribution.ts";
import { parseLink } from "./link.ts";

export type Clock = () => Date;

export type OpenResult = {
  install: { install_id: string; first_opened_at: string; first_open: boolean };
  // created: toque novo. duplicate: o mesmo clique já estava gravado. ignored: abertura sem link válido.
  touch: { outcome: "created" | "duplicate"; touch: Touch } | { outcome: "ignored"; reason: string };
};

export type SignupAttribution = Decision & {
  user_id: string;
  install_id: string | null;
  signed_up_at: string;
};

export class OriginError extends Error {
  readonly status: 404 | 409 | 422;
  readonly code: string;

  constructor(status: 404 | 409 | 422, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

type SignupRow = { user_id: string; install_id: string | null; signed_up_at: string; window_days: number };

const ID = /^[A-Za-z0-9_-]{1,64}$/;

function identifier(value: unknown): string {
  return typeof value === "string" && ID.test(value.trim()) ? value.trim() : "";
}

export function createOrigin(db: DatabaseSync, options: { clock: Clock; windowDays: number }) {
  const { clock, windowDays } = options;

  function touchesOf(installId: string): Touch[] {
    return db
      .prepare("SELECT id, source, ref, click_id, touched_at FROM touches WHERE install_id = ? ORDER BY touched_at, rowid")
      .all(installId) as Touch[];
  }

  // O app chama isto em toda abertura, com a URL que o abriu quando houver. A primeira chamada
  // fixa first_opened_at; as seguintes não mexem nele. O horário é sempre o do servidor.
  function recordOpen(rawInstallId: string, input: { url?: unknown }): OpenResult {
    const installId = identifier(rawInstallId);
    if (!installId) throw new OriginError(422, "install_id_invalid", "install_id deve ter letras, números, _ ou -");
    const now = clock().toISOString();
    const inserted = db
      .prepare("INSERT OR IGNORE INTO installs (install_id, first_opened_at) VALUES (?, ?)")
      .run(installId, now);
    const { first_opened_at: firstOpenedAt } = db
      .prepare("SELECT first_opened_at FROM installs WHERE install_id = ?")
      .get(installId) as { first_opened_at: string };
    const install = { install_id: installId, first_opened_at: firstOpenedAt, first_open: Number(inserted.changes) === 1 };

    if (typeof input.url !== "string" || input.url.trim() === "") {
      return { install, touch: { outcome: "ignored", reason: "abertura sem link" } };
    }
    const parsed = parseLink(input.url.trim());
    if (!parsed.ok) return { install, touch: { outcome: "ignored", reason: parsed.reason } };

    const { source, ref, click_id: clickId } = parsed.payload;
    const created = db
      .prepare(
        "INSERT OR IGNORE INTO touches (id, install_id, click_id, source, ref, url, touched_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(`tch_${crypto.randomUUID()}`, installId, clickId, source, ref, input.url.trim(), now);
    const touch = db
      .prepare("SELECT id, source, ref, click_id, touched_at FROM touches WHERE install_id = ? AND click_id = ?")
      .get(installId, clickId) as Touch;
    return { install, touch: { outcome: Number(created.changes) === 1 ? "created" : "duplicate", touch } };
  }

  function decide(signup: SignupRow): SignupAttribution {
    const install = signup.install_id
      ? (db.prepare("SELECT first_opened_at FROM installs WHERE install_id = ?").get(signup.install_id) as
          | { first_opened_at: string }
          | undefined)
      : undefined;
    const decision = decideOrigin({
      firstOpenedAt: install?.first_opened_at ?? null,
      signedUpAt: signup.signed_up_at,
      touches: signup.install_id ? touchesOf(signup.install_id) : [],
      // A janela que valia no cadastro fica gravada: mudar a configuração depois não reescreve o passado.
      windowDays: signup.window_days,
    });
    return { user_id: signup.user_id, install_id: signup.install_id, signed_up_at: signup.signed_up_at, ...decision };
  }

  function signup(input: { user_id?: unknown; install_id?: unknown }): { created: boolean; attribution: SignupAttribution } {
    const userId = identifier(input.user_id);
    const installId = identifier(input.install_id) || null;
    if (!userId) throw new OriginError(422, "user_id_invalid", "user_id é obrigatório");

    const existing = db.prepare("SELECT * FROM signups WHERE user_id = ?").get(userId) as SignupRow | undefined;
    if (existing) return { created: false, attribution: decide(existing) };
    if (installId && db.prepare("SELECT 1 FROM signups WHERE install_id = ?").get(installId)) {
      throw new OriginError(409, "install_already_signed_up", "essa instalação já gerou um cadastro");
    }

    const row: SignupRow = { user_id: userId, install_id: installId, signed_up_at: clock().toISOString(), window_days: windowDays };
    const attribution = decide(row);
    db.prepare(
      `INSERT INTO signups (user_id, install_id, signed_up_at, origin_source, origin_ref, winning_touch_id,
         reason_code, reason, window_days)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      userId,
      installId,
      row.signed_up_at,
      attribution.origin.source,
      attribution.origin.ref,
      attribution.origin.touch_id,
      attribution.reason_code,
      attribution.reason,
      windowDays,
    );
    return { created: true, attribution };
  }

  // Recalcula a decisão com os mesmos dados. Toques gravados depois do cadastro aparecem na
  // lista como perdedores (after_signup) e nunca mudam o vencedor.
  function attribution(userId: string): SignupAttribution {
    const row = db.prepare("SELECT * FROM signups WHERE user_id = ?").get(userId) as SignupRow | undefined;
    if (!row) throw new OriginError(404, "signup_not_found", "cadastro não encontrado");
    return decide(row);
  }

  return { recordOpen, signup, attribution };
}
