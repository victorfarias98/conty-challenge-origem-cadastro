import { describe, expect, it } from "vitest";
import { type Touch, decideOrigin } from "../src/attribution.ts";
import { type Source, buildLink, parseLink } from "../src/link.ts";

const FIRST_OPEN = "2026-03-10T12:00:00.000Z";
const WINDOW_DAYS = 7;
const WINDOW_END = "2026-03-17T12:00:00.000Z";
const AFTER_WINDOW_END = "2026-03-17T12:00:00.001Z";

function touch(id: string, source: Source, touchedAt: string, clickId = `clk_${id}`): Touch {
  return { id, source, ref: `${source}_ref`, click_id: clickId, touched_at: touchedAt };
}

function decide(touches: Touch[], signedUpAt = "2026-03-12T12:00:00.000Z", firstOpenedAt: string | null = FIRST_OPEN) {
  return decideOrigin({ firstOpenedAt, signedUpAt, touches, windowDays: WINDOW_DAYS });
}

describe("link", () => {
  it("monta e lê o link de campanha", () => {
    const link = buildLink("https://app.conty.com/entrar", { source: "campaign", ref: "cmp_verao26", click_id: "clk_8f3a" });
    expect(link).toBe("https://app.conty.com/entrar?ct_source=campaign&ct_ref=cmp_verao26&ct_click=clk_8f3a");
    expect(parseLink(link)).toEqual({ ok: true, payload: { source: "campaign", ref: "cmp_verao26", click_id: "clk_8f3a" } });
  });

  it("monta e lê o link de indicação", () => {
    const link = buildLink("https://app.conty.com/entrar", { source: "referral", ref: "crt_ana", click_id: "clk_b71c" });
    expect(link).toBe("https://app.conty.com/entrar?ct_source=referral&ct_ref=crt_ana&ct_click=clk_b71c");
    expect(parseLink(link)).toMatchObject({ ok: true, payload: { source: "referral", ref: "crt_ana" } });
  });

  it("recusa link sem origem conhecida, sem ref ou sem clique, dizendo o motivo", () => {
    expect(parseLink("https://app.conty.com/entrar")).toMatchObject({ ok: false });
    expect(parseLink("https://app.conty.com/entrar?ct_source=tv&ct_ref=x&ct_click=c")).toMatchObject({ ok: false });
    expect(parseLink("https://app.conty.com/entrar?ct_source=campaign&ct_click=c")).toMatchObject({ ok: false });
    expect(parseLink("https://app.conty.com/entrar?ct_source=campaign&ct_ref=x")).toMatchObject({ ok: false });
    expect(parseLink("não é url")).toMatchObject({ ok: false });
  });
});

describe("qual toque vence", () => {
  it("com dois links antes do cadastro, vence o mais recente", () => {
    const decision = decide([
      touch("a", "campaign", "2026-03-10T12:00:00.000Z"),
      touch("b", "community", "2026-03-11T09:00:00.000Z"),
    ]);

    expect(decision.origin).toEqual({ source: "community", ref: "community_ref", touch_id: "b" });
    expect(decision.touches.map((entry) => [entry.id, entry.outcome, entry.reason_code])).toEqual([
      ["a", "lost", "earlier_than_winner"],
      ["b", "won", "last_valid_touch"],
    ]);
  });

  it("no empate de horário, indicação vence campanha, que vence comunidade", () => {
    const sameInstant = "2026-03-11T09:00:00.000Z";
    const decision = decide([
      touch("a", "community", sameInstant),
      touch("b", "campaign", sameInstant),
      touch("c", "referral", sameInstant),
    ]);

    expect(decision.origin.touch_id).toBe("c");
    expect(decision.touches.find((entry) => entry.id === "c")).toMatchObject({ outcome: "won", reason_code: "tie_won_by_source_priority" });
    expect(decision.touches.find((entry) => entry.id === "b")?.reason_code).toBe("tie_lost_by_source_priority");
    expect(decide([touch("a", "community", sameInstant), touch("b", "campaign", sameInstant)]).origin.touch_id).toBe("b");
  });

  it("no empate de horário e de origem, vence o menor ct_click, em qualquer ordem de entrada", () => {
    const sameInstant = "2026-03-11T09:00:00.000Z";
    const first = touch("a", "campaign", sameInstant, "clk_zzz");
    const second = touch("b", "campaign", sameInstant, "clk_aaa");

    expect(decide([first, second]).origin.touch_id).toBe("b");
    expect(decide([second, first]).origin.touch_id).toBe("b");
    expect(decide([first, second]).touches.map((entry) => entry.reason_code).sort()).toEqual([
      "tie_lost_by_click_id",
      "tie_won_by_click_id",
    ]);
  });

  it("toque posterior ao cadastro não vence, mesmo sendo o mais recente", () => {
    const decision = decide([
      touch("a", "campaign", "2026-03-11T09:00:00.000Z"),
      touch("b", "referral", "2026-03-12T12:00:00.001Z"),
    ]);

    expect(decision.origin.touch_id).toBe("a");
    expect(decision.touches.find((entry) => entry.id === "b")).toMatchObject({ outcome: "lost", reason_code: "after_signup" });
  });

  it("toque no exato instante do cadastro ainda conta", () => {
    expect(decide([touch("a", "campaign", "2026-03-12T12:00:00.000Z")]).origin.touch_id).toBe("a");
  });
});

describe("janela de validade a partir da primeira abertura", () => {
  it("vale no último instante da janela", () => {
    const decision = decide([touch("a", "campaign", FIRST_OPEN)], WINDOW_END);
    expect(decision.origin.source).toBe("campaign");
    expect(decision.window).toEqual({ starts_at: FIRST_OPEN, ends_at: WINDOW_END, days: WINDOW_DAYS });
  });

  it("cadastro 1 ms depois do fim da janela fica orgânico, com o motivo", () => {
    const decision = decide([touch("a", "campaign", FIRST_OPEN)], AFTER_WINDOW_END);

    expect(decision.origin).toEqual({ source: "organic", ref: null, touch_id: null });
    expect(decision.reason_code).toBe("signup_after_window");
    expect(decision.touches[0]).toMatchObject({ outcome: "lost", reason_code: "signup_after_window" });
  });

  it("a janela conta da primeira abertura, não do toque mais recente", () => {
    const lateTouch = touch("b", "referral", "2026-03-17T11:00:00.000Z");
    expect(decide([lateTouch], WINDOW_END).origin.touch_id).toBe("b");
    expect(decide([lateTouch], AFTER_WINDOW_END).origin.source).toBe("organic");
  });

  it("toque fora da janela não vence", () => {
    const decision = decide([touch("a", "campaign", "2026-03-18T09:00:00.000Z")], "2026-03-19T09:00:00.000Z");
    expect(decision.origin.source).toBe("organic");
    expect(decision.touches[0]?.reason_code).toBe("outside_window");
  });
});

describe("cadastro orgânico", () => {
  it("sem nenhum toque, fica orgânico com motivo gravado", () => {
    const decision = decide([]);
    expect(decision.origin.source).toBe("organic");
    expect(decision.reason_code).toBe("no_touch");
    expect(decision.reason).not.toBe("");
  });

  it("só com toque posterior ao cadastro, fica orgânico e diz por quê", () => {
    const decision = decide([touch("a", "campaign", "2026-03-13T09:00:00.000Z")]);
    expect(decision.reason_code).toBe("only_touches_after_signup");
  });

  it("sem registro de primeira abertura, fica orgânico e diz por quê", () => {
    const decision = decide([], "2026-03-12T12:00:00.000Z", null);
    expect(decision.reason_code).toBe("no_first_open");
    expect(decision.window.ends_at).toBeNull();
  });
});
