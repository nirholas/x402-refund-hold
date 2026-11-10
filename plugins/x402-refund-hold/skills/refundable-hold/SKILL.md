---
name: refundable-hold
description: Use the $0.01 refundable-hold pattern as drop-in Express middleware: charge a hold, auto-refund when fulfilment fails, and read the ledger. Use when adding or testing hold-then-refund payments on an x402 route.
---

# x402-refund-hold refundable holds

A reference service for the hold pattern: the buyer pays a small hold up front, the merchant tries to fulfil, and on failure the hold is refunded automatically and recorded in a ledger. The demo route lets you force each outcome.

## Run the server

The repo is a self-hosted Express service. It is not published to npm, so run it from a clone.

```bash
git clone https://github.com/nirholas/x402-refund-hold && cd x402-refund-hold
npm install
cp .env.example .env   # optional: the defaults run out of the box
npm run dev            # listens on http://localhost:4031 (override with PORT)
```

Set `PAY_TO_ADDRESS` (Base) and `SOLANA_PAY_TO_ADDRESS` (Solana) in `.env` to receive payments yourself.
`GET http://localhost:4031/.well-known/x402` lists every route with its price, and `GET /health` is the liveness probe.

## Routes

| Route | Price | Purpose |
|---|---|---|
| `POST /demo/book` | $0.01 | Demo booking behind the hold middleware. Body fields: `name` (default `Agent Guest`), `time` (ISO-8601, default now plus 3h), `partySize` (default 2), `simulate` (`success`, `failure` or `reject`) |
| `GET /holds/:id` | free | Current ledger state of a hold (`status` is held, captured, settled, refunded or voided). 404 `HOLD_NOT_FOUND` for an unknown id |
| `POST /verify` | free | Verify a signed record. Body needs `payload` and `signature`, else 400 `BAD_REQUEST` |

The middleware itself lives in `src/` and is meant to be copied into your own Express app; read it there for the exact options.

The full request and response schemas are in `skill.md` at the repo root (the running server also serves it at `GET /skill.md`).

## Paying

Paid routes answer an unpaid request with HTTP 402 and an `accepts` array with one entry per rail (USDC on Base and USDC on Solana). A client picks an entry, signs, and retries with the `X-PAYMENT` header. The 200 body carries the artifact and an `X-PAYMENT-RESPONSE` header carries the settlement receipt. Any x402 client works (`x402-fetch` with `viem` on the EVM rail). Each paid call spends real USDC on whichever network the server is configured for (`NETWORK`, `SOLANA_NETWORK`), so show the user the route, price and network and get a yes before paying.

## Worked example

```bash
curl -si -X POST http://localhost:4031/demo/book -H 'content-type: application/json' -d '{"name":"Ada","simulate":"failure"}'
```

Unpaid, this returns 402 with the two-rail `accepts`. After the user approves the $0.01 hold, pay it with an x402 client using `simulate: "failure"`, then `GET /holds/<id>` to see the refund recorded. `npm run client` runs `examples/agent-client.ts` against the server.
