import { SOURCES, type Source } from "./link.ts";

export type Touch = { id: string; source: Source; ref: string; click_id: string; touched_at: string };

export type TouchReason =
  | "last_valid_touch"
  | "tie_won_by_source_priority"
  | "tie_won_by_click_id"
  | "earlier_than_winner"
  | "tie_lost_by_source_priority"
  | "tie_lost_by_click_id"
  | "after_signup"
  | "outside_window"
  | "signup_after_window";

export type OriginReason =
  | "touch_won"
  | "no_first_open"
  | "no_touch"
  | "signup_after_window"
  | "only_touches_after_signup";

export type TouchVerdict = Touch & { outcome: "won" | "lost"; reason_code: TouchReason; reason: string };

export type Decision = {
  origin: { source: Source | "organic"; ref: string | null; touch_id: string | null };
  reason_code: OriginReason;
  reason: string;
  window: { starts_at: string | null; ends_at: string | null; days: number };
  touches: TouchVerdict[];
};

const DAY_MS = 86_400_000;

const TOUCH_REASON: Record<TouchReason, string> = {
  last_valid_touch: "último toque válido antes do cadastro",
  tie_won_by_source_priority: "empate de horário; venceu pela prioridade da origem (indicação, campanha, comunidade)",
  tie_won_by_click_id: "empate de horário e de origem; venceu o menor ct_click",
  earlier_than_winner: "houve um toque válido mais recente",
  tie_lost_by_source_priority: "empate de horário; perdeu pela prioridade da origem",
  tie_lost_by_click_id: "empate de horário e de origem; perdeu pelo ct_click",
  after_signup: "link aberto depois do cadastro",
  outside_window: "toque depois do fim da janela de validade",
  signup_after_window: "o cadastro aconteceu depois do fim da janela de validade",
};

const ORIGIN_REASON: Record<Exclude<OriginReason, "touch_won">, string> = {
  no_first_open: "cadastro sem registro de primeira abertura do app",
  no_touch: "nenhum link de atribuição foi aberto antes do cadastro",
  signup_after_window: "o cadastro aconteceu depois do fim da janela de validade da origem",
  only_touches_after_signup: "os únicos links abertos vieram depois do cadastro",
};

function verdict(touch: Touch, outcome: "won" | "lost", code: TouchReason): TouchVerdict {
  return { ...touch, outcome, reason_code: code, reason: TOUCH_REASON[code] };
}

// Do vencedor para os perdedores: mais recente primeiro; empate de horário pela prioridade da
// origem; empate total pelo menor ct_click, só para o resultado não depender da ordem de gravação.
function compareTouches(left: Touch, right: Touch): number {
  const byTime = Date.parse(right.touched_at) - Date.parse(left.touched_at);
  if (byTime !== 0) return byTime;
  const byPriority = SOURCES.indexOf(left.source) - SOURCES.indexOf(right.source);
  if (byPriority !== 0) return byPriority;
  return left.click_id < right.click_id ? -1 : left.click_id > right.click_id ? 1 : 0;
}

// A regra inteira de origem do cadastro. Função pura: mesmos toques e horários, mesma decisão.
//
// Vale o último toque. Um toque é válido quando aconteceu até o cadastro e o cadastro aconteceu
// dentro da janela, que começa na primeira abertura do app e dura windowDays dias (fim inclusivo).
export function decideOrigin(input: {
  firstOpenedAt: string | null;
  signedUpAt: string;
  touches: Touch[];
  windowDays: number;
}): Decision {
  const { firstOpenedAt, signedUpAt, touches, windowDays } = input;
  const signedUp = Date.parse(signedUpAt);
  const windowEnd = firstOpenedAt === null ? null : Date.parse(firstOpenedAt) + windowDays * DAY_MS;
  const window = {
    starts_at: firstOpenedAt,
    ends_at: windowEnd === null ? null : new Date(windowEnd).toISOString(),
    days: windowDays,
  };
  const organic = (code: Exclude<OriginReason, "touch_won">, verdicts: TouchVerdict[]): Decision => ({
    origin: { source: "organic", ref: null, touch_id: null },
    reason_code: code,
    reason: ORIGIN_REASON[code],
    window,
    touches: verdicts,
  });
  const chronological = [...touches].sort((left, right) => compareTouches(right, left));

  if (windowEnd === null) {
    return organic("no_first_open", chronological.map((touch) => verdict(touch, "lost", "after_signup")));
  }

  const rejected = new Map<string, TouchReason>();
  for (const touch of touches) {
    const touchedAt = Date.parse(touch.touched_at);
    if (touchedAt > signedUp) rejected.set(touch.id, "after_signup");
    else if (touchedAt > windowEnd) rejected.set(touch.id, "outside_window");
    else if (signedUp > windowEnd) rejected.set(touch.id, "signup_after_window");
  }
  const valid = touches.filter((touch) => !rejected.has(touch.id)).sort(compareTouches);
  const winner = valid[0];

  if (!winner) {
    const verdicts = chronological.map((touch) => verdict(touch, "lost", rejected.get(touch.id) ?? "after_signup"));
    if (touches.length === 0) return organic("no_touch", verdicts);
    const beforeSignup = touches.some((touch) => Date.parse(touch.touched_at) <= signedUp);
    return organic(beforeSignup ? "signup_after_window" : "only_touches_after_signup", verdicts);
  }

  const tied = valid.filter((touch) => touch.touched_at === winner.touched_at && touch.id !== winner.id);
  const winnerReason: TouchReason =
    tied.length === 0
      ? "last_valid_touch"
      : tied.some((touch) => touch.source !== winner.source)
        ? "tie_won_by_source_priority"
        : "tie_won_by_click_id";
  const lostReason = (touch: Touch): TouchReason => {
    const known = rejected.get(touch.id);
    if (known) return known;
    if (touch.touched_at !== winner.touched_at) return "earlier_than_winner";
    return touch.source !== winner.source ? "tie_lost_by_source_priority" : "tie_lost_by_click_id";
  };

  return {
    origin: { source: winner.source, ref: winner.ref, touch_id: winner.id },
    reason_code: "touch_won",
    reason: TOUCH_REASON[winnerReason],
    window,
    touches: chronological.map((touch) =>
      touch.id === winner.id ? verdict(touch, "won", winnerReason) : verdict(touch, "lost", lostReason(touch)),
    ),
  };
}
