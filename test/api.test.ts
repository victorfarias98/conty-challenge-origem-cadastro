import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import { openDatabase } from "../src/db.ts";
import type { OpenResult, SignupAttribution } from "../src/origin.ts";

type App = ReturnType<typeof createApp>;

const CAMPAIGN_LINK = "https://app.conty.com/entrar?ct_source=campaign&ct_ref=cmp_verao26&ct_click=clk_8f3a";
const REFERRAL_LINK = "https://app.conty.com/entrar?ct_source=referral&ct_ref=crt_ana&ct_click=clk_b71c";

let app: App;
let now: Date;

function at(instant: string): void {
  now = new Date(instant);
}

async function open(url?: string, installId = "ins_1"): Promise<{ status: number; body: OpenResult }> {
  const res = await app.request(`/installs/${installId}/opens`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(url === undefined ? {} : { url }),
  });
  return { status: res.status, body: (await res.json()) as OpenResult };
}

async function signup(userId = "usr_1", installId: string | undefined = "ins_1"): Promise<Response> {
  return app.request("/signups", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ user_id: userId, install_id: installId }),
  });
}

async function attribution(userId = "usr_1"): Promise<SignupAttribution> {
  return (await (await app.request(`/signups/${userId}/attribution`)).json()) as SignupAttribution;
}

beforeEach(() => {
  at("2026-03-10T12:00:00.000Z");
  app = createApp(openDatabase(), { clock: () => now, windowDays: 7 });
});

describe("primeira abertura", () => {
  it("fixa first_opened_at na primeira chamada e não muda nas seguintes", async () => {
    const first = await open(CAMPAIGN_LINK);
    at("2026-03-11T12:00:00.000Z");
    const second = await open();

    expect(first.status).toBe(201);
    expect(first.body.install).toMatchObject({ first_opened_at: "2026-03-10T12:00:00.000Z", first_open: true });
    expect(second.status).toBe(200);
    expect(second.body.install).toMatchObject({ first_opened_at: "2026-03-10T12:00:00.000Z", first_open: false });
  });

  it("registra a abertura mesmo quando o link não é de atribuição, dizendo por que ignorou", async () => {
    const { body } = await open("https://app.conty.com/entrar?utm_source=instagram");
    expect(body.touch).toMatchObject({ outcome: "ignored" });
    expect(body.install.first_open).toBe(true);
  });
});

describe("clique repetido", () => {
  it("o mesmo clique reaberto não cria outro toque nem muda o horário do primeiro", async () => {
    const first = await open(CAMPAIGN_LINK);
    at("2026-03-11T12:00:00.000Z");
    const again = await open(CAMPAIGN_LINK);

    expect(first.body.touch.outcome).toBe("created");
    expect(again.body.touch).toMatchObject({ outcome: "duplicate", touch: { touched_at: "2026-03-10T12:00:00.000Z" } });

    await signup();
    const result = await attribution();
    expect(result.touches).toHaveLength(1);
    expect(result.origin).toMatchObject({ source: "campaign", ref: "cmp_verao26" });
  });
});

describe("cadastro consome a origem", () => {
  it("com dois links diferentes antes do cadastro, grava o último e explica os dois", async () => {
    await open(CAMPAIGN_LINK);
    at("2026-03-11T09:00:00.000Z");
    await open(REFERRAL_LINK);
    at("2026-03-12T12:00:00.000Z");

    const res = await signup();

    expect(res.status).toBe(201);
    const result = (await res.json()) as SignupAttribution;
    expect(result.origin).toMatchObject({ source: "referral", ref: "crt_ana" });
    expect(result.reason_code).toBe("touch_won");
    expect(result.window).toEqual({ starts_at: "2026-03-10T12:00:00.000Z", ends_at: "2026-03-17T12:00:00.000Z", days: 7 });
    expect(result.touches.map((entry) => [entry.source, entry.outcome, entry.reason_code])).toEqual([
      ["campaign", "lost", "earlier_than_winner"],
      ["referral", "won", "last_valid_touch"],
    ]);
    expect(result.touches.every((entry) => entry.reason !== "")).toBe(true);
  });

  it("link aberto depois do cadastro aparece na auditoria e não muda a origem", async () => {
    await open(CAMPAIGN_LINK);
    await signup();
    at("2026-03-11T09:00:00.000Z");
    await open(REFERRAL_LINK);

    const result = await attribution();

    expect(result.origin).toMatchObject({ source: "campaign" });
    expect(result.touches.map((entry) => [entry.source, entry.outcome, entry.reason_code])).toEqual([
      ["campaign", "won", "last_valid_touch"],
      ["referral", "lost", "after_signup"],
    ]);
  });

  it("cadastro depois da janela fica orgânico e mostra o toque que expirou", async () => {
    await open(CAMPAIGN_LINK);
    at("2026-03-17T12:00:00.001Z");
    await signup();

    const result = await attribution();

    expect(result.origin.source).toBe("organic");
    expect(result.reason_code).toBe("signup_after_window");
    expect(result.touches[0]).toMatchObject({ outcome: "lost", reason_code: "signup_after_window" });
  });

  it("cadastro no último instante da janela ainda recebe a origem", async () => {
    await open(CAMPAIGN_LINK);
    at("2026-03-17T12:00:00.000Z");
    await signup();
    expect((await attribution()).origin.source).toBe("campaign");
  });

  it("cadastro sem link fica orgânico com o motivo gravado", async () => {
    await open();
    await signup();
    const result = await attribution();
    expect(result.origin).toEqual({ source: "organic", ref: null, touch_id: null });
    expect(result.reason_code).toBe("no_touch");
  });

  it("cadastro sem instalação conhecida fica orgânico, não com dado faltando", async () => {
    await signup("usr_web", undefined);
    const result = await attribution("usr_web");
    expect(result.origin.source).toBe("organic");
    expect(result.reason_code).toBe("no_first_open");
    expect(result.reason).not.toBe("");
  });

  it("repetir o cadastro devolve a mesma origem, sem decidir de novo", async () => {
    await open(CAMPAIGN_LINK);
    const first = await signup();
    at("2026-03-11T09:00:00.000Z");
    await open(REFERRAL_LINK);
    const again = await signup();

    expect(first.status).toBe(201);
    expect(again.status).toBe(200);
    const result = (await again.json()) as SignupAttribution;
    expect(result.origin.source).toBe("campaign");
    expect(result.signed_up_at).toBe("2026-03-10T12:00:00.000Z");
  });

  it("uma instalação não gera origem para dois cadastros", async () => {
    await open(CAMPAIGN_LINK);
    await signup("usr_1");
    expect((await signup("usr_2")).status).toBe(409);
  });

  it("responde 404 para cadastro desconhecido e 422 sem user_id", async () => {
    expect((await app.request("/signups/usr_x/attribution")).status).toBe(404);
    const res = await app.request("/signups", { method: "POST", body: "{}" });
    expect(res.status).toBe(422);
  });
});
