# x402-refund-hold

**The refundable-hold pattern for x402, as drop-in Express middleware.** Charge a hold, auto-refund on failure, ledger included — and every outcome comes back as a signed record in the 200 body.

[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](./LICENSE)
[![x402](https://img.shields.io/badge/x402-payments-0052ff.svg)](https://x402.org)
[![rails: Base + Solana](https://img.shields.io/badge/rails-Base%20%2B%20Solana-14f195.svg)](#pay-on-either-rail)

```bash
npm install x402-refund-hold
```

## The problem

x402's `exact` scheme is **pay-then-serve**. By the time your handler runs, the USDC has already moved. So what happens when the thing you just sold doesn't materialise — no availability, upstream 500, the browser flow timed out?

Returning `409 Sorry` is not an answer. You took the money. And the caller is an autonomous agent: it needs *proof* of the refund, in the response, right now — not an email to a human three days later.

`refundHold()` makes that the default. One line of middleware, and every paid request resolves to exactly one signed artifact: a captured hold with your confirmation attached, or a refund record the customer can verify and act on.

## Why x402 for this

Refunds are the part of per-request payment everyone skips. With API keys and monthly invoices you can absorb a failed call quietly and reconcile later; with x402 the money is already on-chain and the customer is a program that will keep score. Per-request payment only works if per-request *un*-payment works too — that's this package.

## Quickstart

```bash
git clone https://github.com/nirholas/x402-refund-hold && cd x402-refund-hold
npm install
cp .env.example .env      # already filled in with working defaults
npm run dev
```

```bash
# 1. Unpaid → 402 listing BOTH rails
curl -s -X POST localhost:4031/demo/book -H 'content-type: application/json' -d '{}' | jq .accepts

# 2. Paid (any x402 client) → an artifact, whatever happens
npm run client                       # success path
SIMULATE=failure npm run client      # refund path
```

## Use it as a library

```ts
import express from "express";
import { paywall, refundHold, executorFromEnv } from "x402-refund-hold";

const app = express();
app.use(express.json());

// 1. Dual-rail paywall — the 402 offers Base *and* Solana; the client picks.
app.use(paywall({ "POST /book": "$0.01" }, { service: "my-merchant" }));

// 2. Refundable holds on top.
const holds = refundHold({ executor: executorFromEnv() });

app.post("/book", holds, async (req, res) => {
  const booking = await tryToBook(req.body);
  if (booking) {
    res.json({ outcome: "confirmed", booking, hold: req.hold!.capture({ artifact: booking }) });
  } else {
    res.json({ outcome: "refunded", refund: await req.hold!.refund("no availability") });
  }
});
```

### The public API

| export | what it is |
|---|---|
| `paywall(routePrices, { service })` | Dual-rail x402 middleware. `{ "POST /book": "$0.01" }`. Routes not listed stay free. |
| `refundHold(options)` | The hold middleware. Attaches `req.hold`; returns an object carrying `.ledger` and `.stop()`. |
| `req.hold.capture({ artifact, refundableForMs })` | Delivered. Opens the refundable window. Returns a **signed** hold record. |
| `req.hold.refund(reason)` | Money back on the rail it came in on. Returns a **signed** refund record. |
| `req.hold.void(reason)` | Only for holds that never settled — throws if the payment cleared, so you can't strand a customer by accident. |
| `RefundLedger` | File-backed hold ledger: `open`, `capture`, `refund`, `void`, `settle`, `list`, `sweepExpired`, `digest`. |
| `createUsdcRefundExecutor` / `createSolanaUsdcRefundExecutor` / `createDualRailRefundExecutor` | On-chain refunds per rail, or routed automatically. |
| `executorFromEnv()` | Builds the right executor from env; `undefined` (claim mode) when no key is set. |
| `sign` / `verify` / `signed` | HMAC-SHA256 over canonical JSON — how records are made verifiable. |
| `paymentReceipt(res)` | The settlement receipt (rail, network, tx hash/signature, payer) for the current request. |

### Hold lifecycle

```
              capture()                       settle()
  held ──────────────────▶ captured ────────────────────▶ settled
    │                          │
    │ void()                   │ refund()  ·or·  sweepExpired()
    │ (payment never settled)  │ (money goes back on the paying rail)
    ▼                          ▼
  voided                    refunded
```

`sweepExpired()` runs on a timer (`sweepIntervalMs`, default 60s): any captured hold whose `refundableUntil` passes without being settled is refunded automatically. That is the "auto-refund if never served" guarantee — it survives your process forgetting.

## Pay on either rail

Every 402 advertises **both** rails and the client picks:

| rail | network | asset | payTo | facilitator |
|---|---|---|---|---|
| EVM | `base-sepolia` (or `base`) | USDC | `0x40252CFDF8B20Ed757D61ff157719F33Ec332402` | `x402.org/facilitator` |
| Solana | `solana` (or `solana-devnet`) | USDC | `WwwuGbqHrwF5RG89KhUbmRWEvjnRH9k5kVM5p7T3WwW` | `facilitator.payai.network` |

Refunds go back on the rail the payment arrived on — `hold.rail` records which one, and `createDualRailRefundExecutor` routes accordingly. On Solana the facilitator's `extra.feePayer` sponsors the network fee, so payers need only USDC, no SOL.

Set `PAY_TO_ADDRESS` / `SOLANA_PAY_TO_ADDRESS` to receive funds yourself; the defaults above are the suite's public receive addresses so the demo runs unconfigured.

## How x402 works here

```
  agent                      this service                    facilitator
    │  POST /demo/book            │                              │
    │ ───────────────────────────▶│                              │
    │  402 { accepts: [base, solana] }                            │
    │ ◀───────────────────────────│                              │
    │  sign chosen rail           │                              │
    │  POST + X-PAYMENT           │                              │
    │ ───────────────────────────▶│ verify ─────────────────────▶│
    │                             │ settle ─────────────────────▶│
    │                             │        hold opened           │
    │                             │        handler runs          │
    │  200 + artifact + X-PAYMENT-RESPONSE                        │
    │ ◀───────────────────────────│                              │
```

If the handler fails, the same 200 carries the signed refund record instead of the confirmation.

## Real backend / API keys

Nothing here needs an API key. The booking service in `src/service.ts` is a deterministic demo (its outcome is driven by the request's `simulate` field) — the *library* is the product, and it is fully real.

The one thing env unlocks is on-chain refunds:

| env | effect |
|---|---|
| *(unset)* | Refunds are HMAC-signed **claims** — recorded in the ledger, settled by you out-of-band. `mode: "claim"`. |
| `REFUND_PRIVATE_KEY` | Real ERC-20 USDC transfers back to the payer on Base. `mode: "onchain"` with a `txHash`. |
| `SOLANA_REFUND_SECRET_KEY` | Real SPL USDC transfers back on Solana. |

Set both to cover both rails. See `.env.example` — every variable is commented.

## For AI agents

- **`skill.md`** (repo root) — the agent-facing contract: endpoints, prices, response schemas, error codes.
- **`/.well-known/x402`** — machine-readable manifest, served by the running app and committed at `public/.well-known/x402`.
- **`openapi.json`** — OpenAPI 3.1 including the 402 responses and `PaymentRequirements` schema.
- **MCP** — `examples/mcp-tool.md` shows how to expose this as a Claude tool.
- **Discovery** — list your deployment on [x402scan.com](https://x402scan.com), the x402 Bazaar, and [agentic.market](https://agentic.market); they index the `.well-known/x402` format above.

## Docs

Full docs: **https://nirholas.github.io/x402-refund-hold/** — [tutorial](https://nirholas.github.io/x402-refund-hold/tutorial), [API reference](https://nirholas.github.io/x402-refund-hold/api), [for agents](https://nirholas.github.io/x402-refund-hold/agents).

## Support

Questions, bugs, integrations: **nichxbt@gmail.com**

Part of the [x402 Suite](https://github.com/nirholas/x402-suite).

## License

Apache-2.0 — see [LICENSE](./LICENSE).

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=nirholas/x402-refund-hold&type=Date)](https://www.star-history.com/#nirholas/x402-refund-hold&Date)
