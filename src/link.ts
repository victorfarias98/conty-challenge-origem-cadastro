// O contrato do link. Tudo o que a atribuição precisa viaja na própria URL, porque o
// navegador interno (webview) dos apps de rede social costuma não mandar referrer.

// A ordem é a prioridade no desempate de horário: indicação, depois campanha, depois comunidade.
export const SOURCES = ["referral", "campaign", "community"] as const;
export type Source = (typeof SOURCES)[number];

export type LinkPayload = {
  source: Source;
  // Quem ou o que trouxe: id do criador que indicou, da campanha ou da comunidade.
  ref: string;
  // Identifica o clique. O mesmo clique reaberto não vira outro toque.
  click_id: string;
};

export type ParsedLink = { ok: true; payload: LinkPayload } | { ok: false; reason: string };

const TOKEN = /^[A-Za-z0-9_-]{1,64}$/;

export function buildLink(baseUrl: string, payload: LinkPayload): string {
  const url = new URL(baseUrl);
  url.searchParams.set("ct_source", payload.source);
  url.searchParams.set("ct_ref", payload.ref);
  url.searchParams.set("ct_click", payload.click_id);
  return url.toString();
}

export function parseLink(rawUrl: string): ParsedLink {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, reason: "url inválida" };
  }
  const source = SOURCES.find((candidate) => candidate === url.searchParams.get("ct_source"));
  const ref = url.searchParams.get("ct_ref") ?? "";
  const clickId = url.searchParams.get("ct_click") ?? "";
  if (!source) return { ok: false, reason: `ct_source ausente ou fora de: ${SOURCES.join(", ")}` };
  if (!TOKEN.test(ref)) return { ok: false, reason: "ct_ref ausente ou malformado" };
  if (!TOKEN.test(clickId)) return { ok: false, reason: "ct_click ausente ou malformado" };
  return { ok: true, payload: { source, ref, click_id: clickId } };
}
