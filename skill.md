# Skill: x402-refund-hold

## What this service does

`x402-refund-hold` implements the refundable-hold pattern for x402 merchants. x402's `exact` scheme is pay-then-serve: USDC moves before the handler runs. When the thing you paid for then fails to materialise, this service refunds you and hands back a **signed refund record in the same 200 response** — so a paying agent always leaves with a verifiable artifact, whether the booking succeeded or not. The demo endpoint shows the pattern; the npm package (`x402-refund-hold`) is the reusable middleware.

**Payment: USDC on Base or Solana — your client picks the rail.** Every 402 lists both.

## Base URL

```
<BASE_URL>          # e.g. http://localhost:4031, or your deployment
```

## Endpoints

### POST /demo/book — $0.01

Books a demo reservation behind a refundable hold.

**Body** (all optional):

| field | type | default | meaning |
|---|---|---|---|
| `name` | string | `"Agent Guest"` | Guest name on the reservation |
| `time` | ISO-8601 string | now + 3h | Requested time |
| `partySize` | number | `2` | Covers |
| `simulate` | `"success"` \| `"failure"` \| `"reject"` | `"success"` | Forces the outcome so you can exercise every branch |

**Response 200** — one of three shapes, always with an artifact:

```jsonc
// simulate=success
{
  "outcome": "confirmed",
  "confirmation": {
    "reservationId": "resv_7f1c…", "name": "Agent Guest",
    "confirmedTime": "2026-08-07T19:00:00.000Z", "partySize": 2,
    "venue": "Demo Bistro (x402-refund-hold demo)", "bookedAt": "2026-08-07T16:00:00.000Z"
  },
  "hold": {
    "payload": { "id": "hold_…", "status": "captured", "payer": "0x…", "amountUsd": 0.01,
                 "rail": "evm", "network": "base-sepolia", "paymentTx": "0x…",
                 "refundableUntil": "2026-08-08T16:00:00.000Z" },
    "signature": "…", "algorithm": "HMAC-SHA256"
  },
  "refundTerms": "Refundable for 24h via the merchant; auto-refund sweep if never fulfilled."
}

// simulate=failure  → the booking failed after settlement
{
  "outcome": "refunded",
  "reason": "table was taken between quote and booking",
  "refund": {
    "payload": { "type": "refund", "holdId": "hold_…", "payer": "0x…", "amountUsd": 0.01,
                 "rail": "evm", "network": "base-sepolia", "reason": "…",
                 "mode": "claim", "issuedAt": "2026-08-07T16:00:00.000Z" },
    "signature": "…", "algorithm": "HMAC-SHA256"
  }
}

// simulate=reject   → same shape, "outcome": "rejected"
```

`refund.payload.mode` is `"onchain"` when the operator configured a refund wallet (`txHash` present) and `"claim"` when the refund is a signed obligation to settle out-of-band.

### GET /holds/:id — free

Current ledger state for a hold.

```jsonc
{ "hold": { "id": "hold_…", "status": "captured", "payer": "0x…", "amountUsd": 0.01,
            "rail": "evm", "network": "base-sepolia", "settled": true,
            "refundableUntil": "…", "artifact": { … } } }
```

`status` ∈ `held` → `captured` → `settled`, or `refunded` / `voided`.

### POST /verify — free

Body `{ "payload": <the record's payload>, "signature": "<hex>" }` → `{ "valid": true|false }`. Verifies any hold or refund record this service issued.

### GET /health — free

`{ "ok": true, "service": "x402-refund-hold", "rails": [ … ] }` — the rails currently advertised.

## Payment

- Protocol: **x402** (HTTP 402 Payment Required), `scheme: "exact"`, `x402Version: 1`.
- Asset: **USDC** (6 decimals) on **both** rails.
- Rails advertised in every 402 `accepts` array:
  - `network: "base-sepolia"` (or `base`), payTo `0x40252CFDF8B20Ed757D61ff157719F33Ec332402`, facilitator `https://x402.org/facilitator`.
  - `network: "solana"` (or `solana-devnet`), payTo `WwwuGbqHrwF5RG89KhUbmRWEvjnRH9k5kVM5p7T3WwW`, facilitator `https://facilitator.payai.network`. `extra.feePayer` sponsors the SOL network fee, so you need only USDC.
- Pay with `x402-fetch`, `@three-ws/x402-payment-modal`, or any x402 client: read `accepts`, pick the rail your wallet supports, sign, retry with the base64 `X-PAYMENT` header.
- The 200 carries `X-PAYMENT-RESPONSE` (base64 JSON): `{ success, rail, network, transaction, payer, amount, asset, resource }`.
- The hold id is also returned in the `X-Hold-Id` response header.

## Error codes

| status | body `error` | meaning |
|---|---|---|
| 402 | `X-PAYMENT header is required` | Unpaid. Read `accepts`, pay, retry. |
| 402 | `invalid X-PAYMENT header: …` | Malformed base64/JSON payload. |
| 402 | `unsupported rail: …` | You signed for a network this endpoint does not accept. |
| 402 | `payment rejected: …` | Facilitator refused the payment (expired, wrong amount, insufficient balance). |
| 402 | `settlement failed: …` | Verified but could not settle on-chain. Nothing was charged; retry. |
| 400 | `BAD_REQUEST` | `/verify` called without `payload` + `signature`. |
| 404 | `HOLD_NOT_FOUND` | Unknown hold id. |
| 500 | `no_payment_rail` | Server misconfigured: no valid payTo on either rail. |
| 502 | `facilitator_unreachable` / `settlement_error` | Facilitator down. Retry with backoff; you were not charged. |

## Discovery

- Machine-readable manifest: `<BASE_URL>/.well-known/x402`
- Docs: https://nirholas.github.io/x402-refund-hold/
- Source: https://github.com/nirholas/x402-refund-hold
- Contact: nichxbt@gmail.com
