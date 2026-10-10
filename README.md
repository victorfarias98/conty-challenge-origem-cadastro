# Conty. Origem do cadastro no app

Contrato e implementação da atribuição de origem: o que viaja no link, o que o app grava na primeira abertura e como o cadastro decide se o criador veio de campanha, indicação, comunidade ou orgânico.

A regra é uma biblioteca pura (`decideOrigin`), com uma API fina por cima para gravar aberturas e cadastros.

## Como rodar

Node 22 ou mais novo.

```bash
npm install
npm test
npm run dev
```

A API sobe em `http://127.0.0.1:3006` e grava em `data/origem.sqlite`. `ATTRIBUTION_WINDOW_DAYS` muda a janela (padrão 7), `PORT` e `DB_PATH` mudam o resto.

## Por onde ler

1. `src/link.ts`: o que viaja no link.
2. `src/attribution.ts`: a regra de qual toque vence, inteira, em uma função pura.
3. `src/origin.ts`: primeira abertura, toques e cadastro.
4. `test/attribution.test.ts` (regra) e `test/api.test.ts` (fluxo).

## O contrato

### 1. O que viaja no link

O webview dos apps de rede social costuma não mandar referrer, então nada depende dele. Tudo vai na própria URL, em três parâmetros:

| Parâmetro | O que é |
|---|---|
| `ct_source` | `campaign`, `referral` ou `community` |
| `ct_ref` | quem trouxe: id da campanha, do criador que indicou ou da comunidade |
| `ct_click` | identificador do clique, gerado quando o link é emitido ou clicado |

Link de campanha:

```
https://app.conty.com/entrar?ct_source=campaign&ct_ref=cmp_verao26&ct_click=clk_8f3a
```

Link de indicação:

```
https://app.conty.com/entrar?ct_source=referral&ct_ref=crt_ana&ct_click=clk_b71c
```

Link sem os três parâmetros válidos não é toque. A abertura é registrada e a resposta diz por que o link foi ignorado.

### 2. O que o app grava na primeira abertura

O app gera um `install_id` na primeira vez que abre, guarda no aparelho e chama, em **toda** abertura:

```
POST /installs/:install_id/opens   { "url": "<link que abriu o app, se houver>" }
```

- A primeira chamada fixa `first_opened_at`. As seguintes não mexem nele.
- Se a URL é um link de atribuição, vira um **toque**.
- Os horários são sempre do servidor; o relógio do aparelho não entra na conta.

### 3. Como o cadastro consome

```
POST /signups   { "user_id": "usr_1", "install_id": "ins_1" }
```

O cadastro decide a origem naquele instante e grava a decisão com o motivo. Repetir o mesmo cadastro devolve a mesma origem, sem decidir de novo.

## Qual toque vence

**Vale o último toque válido antes do cadastro.** O link mais recente é o que de fato levou a pessoa a se cadastrar.

Um toque é válido quando:

- aconteceu até o instante do cadastro (link aberto depois do cadastro não conta), e
- o cadastro aconteceu dentro da janela de validade.

**Janela de validade:** 7 dias, contados a partir da **primeira abertura do app**, com o último instante incluso. Não é contada a partir do clique nem do toque mais recente. Passada a janela sem cadastro, a origem expira e o cadastro fica orgânico. A janela usada fica gravada no cadastro, então mudar a configuração depois não reescreve decisões antigas.

**Empate de horário**, em ordem:

1. Prioridade da origem: `referral`, depois `campaign`, depois `community`. A indicação é uma pessoa específica que convidou; errar contra ela custa mais do que errar contra um canal.
2. Mesma origem: vence o menor `ct_click`. É arbitrário de propósito, e existe só para a decisão não depender da ordem em que os toques foram gravados.

**Clique repetido:** a chave do toque é (`install_id`, `ct_click`). O mesmo clique reaberto não cria outro toque e não muda o horário do primeiro.

**Orgânico nunca é dado faltando.** Todo cadastro sem origem recebe `source: "organic"` e um destes motivos:

| `reason_code` | Quando |
|---|---|
| `no_touch` | nenhum link de atribuição foi aberto antes do cadastro |
| `signup_after_window` | havia toque, mas o cadastro veio depois da janela |
| `only_touches_after_signup` | os únicos links vieram depois do cadastro |
| `no_first_open` | cadastro sem instalação conhecida (por exemplo, feito na web) |

## Auditoria

`GET /signups/:user_id/attribution` mostra a origem, a janela e **todos** os toques da instalação, cada um com o resultado e o motivo. Exemplo: campanha no dia 10, indicação no dia 11, cadastro no dia 12 e um link de comunidade aberto no dia 13.

```json
{
  "user_id": "usr_1",
  "install_id": "ins_1",
  "signed_up_at": "2026-03-12T12:00:00.000Z",
  "origin": { "source": "referral", "ref": "crt_ana", "touch_id": "tch_…" },
  "reason_code": "touch_won",
  "reason": "último toque válido antes do cadastro",
  "window": {
    "starts_at": "2026-03-10T12:00:00.000Z",
    "ends_at": "2026-03-17T12:00:00.000Z",
    "days": 7
  },
  "touches": [
    {
      "id": "tch_…",
      "source": "campaign",
      "ref": "cmp_verao26",
      "click_id": "clk_8f3a",
      "touched_at": "2026-03-10T12:00:00.000Z",
      "outcome": "lost",
      "reason_code": "earlier_than_winner",
      "reason": "houve um toque válido mais recente"
    },
    {
      "id": "tch_…",
      "source": "referral",
      "ref": "crt_ana",
      "click_id": "clk_b71c",
      "touched_at": "2026-03-11T09:00:00.000Z",
      "outcome": "won",
      "reason_code": "last_valid_touch",
      "reason": "último toque válido antes do cadastro"
    },
    {
      "id": "tch_…",
      "source": "community",
      "ref": "com_beleza",
      "click_id": "clk_1d9e",
      "touched_at": "2026-03-13T08:00:00.000Z",
      "outcome": "lost",
      "reason_code": "after_signup",
      "reason": "link aberto depois do cadastro"
    }
  ]
}
```

Motivos possíveis de um toque: `last_valid_touch`, `tie_won_by_source_priority`, `tie_won_by_click_id`, `earlier_than_winner`, `tie_lost_by_source_priority`, `tie_lost_by_click_id`, `after_signup`, `outside_window`, `signup_after_window`.

## API

| Rota | Faz |
|---|---|
| `POST /installs/:install_id/opens` | registra a abertura e, se houver link válido, o toque (`201` na primeira abertura, `200` depois) |
| `POST /signups` | decide e grava a origem (`201`; `200` se o cadastro já existia) |
| `GET /signups/:user_id/attribution` | a decisão com todos os toques e motivos |

## O que ficou de fora

- **Instalação pela loja.** Se o link leva à loja e o app é instalado depois, a URL não chega à primeira abertura. Isso pede deferred deep link (install referrer no Android, por exemplo), que não foi implementado.
- **`ct_click` não é verificado.** Qualquer um pode montar um link com o `ct_ref` de outra pessoa. Um link real seria assinado, ou o clique seria emitido por um redirecionador do servidor.
- **`ct_ref` não é conferido** contra campanhas, criadores ou comunidades existentes.
- **`install_id` é confiado ao app.** Reinstalar gera outro, e a origem da instalação anterior se perde.
- **Uma instalação gera um cadastro.** Um segundo `user_id` na mesma instalação responde `409`.
- **Último toque é uma escolha.** Com mais tempo eu gravaria também o primeiro toque, para o time comparar os dois modelos sem refazer a coleta.
- Autenticação e paginação.

## Uso de IA

O código, os testes e este README foram escritos com Claude Code (Claude Opus), a partir do enunciado. O contrato do link, a regra de último toque e a ordem de desempate foram propostos pela IA.

O que eu revisei: os padrões de backend, as tipagens, os early returns, as constantes e se os testes realmente testam os cenários de falha.
