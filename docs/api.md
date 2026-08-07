# API reference — x402-refund-hold

Two surfaces: the **HTTP API** of the demo server, and the **library** you install into your own server. The library is the product; the server shows it working.

- Machine-readable: [`openapi.json`](https://github.com/nirholas/x402-refund-hold/blob/main/openapi.json) · [`/.well-known/x402`](https://github.com/nirholas/x402-refund-hold/blob/main/public/.well-known/x402)
- Agent-facing summary: [`skill.md`](https://github.com/nirholas/x402-refund-hold/blob/main/skill.md)

---

## HTTP API

Base URL: `http://localhost:4031` in dev, your origin in production.

### `POST /demo/book` — $0.01

Books a demo reservation behind a refundable hold.

**Request body** (JSON, all fields optional)

| field | type | default | notes |
|---|---|---|---|
| `name` | string | `"Agent Guest"` | Guest name |
| `time` | ISO-8601 | now + 3h | Requested time |
| `partySize` | number | `2` | Covers |
| `simulate` | `"success"` \| `"failure"` \| `"reject"` | `"success"` | Forces the outcome so every branch is reachable |

**200 — confirmed**

```jsonc
{
  "outcome": "confirmed",
  "confirmation": {
    "reservationId": "resv_7f1c…",
    "name": "Agent Guest",
    "confirmedTime": "2026-08-07T19:00:00.000Z",
    "partySize": 2,
    "venue": "Demo Bistro (x402-refund-hold demo)",
    "bookedAt": "2026-08-07T16:00:00.000Z"
  },
  "hold": {
    "payload": {
      "id": "hold_9f0c…", "resource": "POST /demo/book", "status": "captured",
      "payer": "0x9a…", "amountUsd": 0.01, "rail": "evm", "network": "base-sepolia",
      "settled": true, "paymentTx": "0xabc…",
      "createdAt": "…", "updatedAt": "…", "refundableUntil": "2026-08-08T16:00:00.000Z",
      "artifact": { "reservationId": "resv_7f1c…" }
    },
    "signature": "5f3a…", "algorithm": "HMAC-SHA256"
  },
  "refundTerms": "Refundable for 24h via the merchant; auto-refund sweep if never fulfilled."
}
```

**200 — refunded / rejected**

```jsonc
{
  "outcome": "refunded",                       // or "rejected"
  "reason": "table was taken between quote and booking",
  "refund": {
    "payload": {
      "type": "refund", "holdId": "hold_9f0c…", "payer": "0x9a…", "amountUsd": 0.01,
      "rail": "evm", "network": "base-sepolia",
      "reason": "table was taken between quote and booking",
      "mode": "claim",                          // "onchain" when a refund wallet is configured
      "txHash": undefined,                      // present when mode === "onchain"
      "issuedAt": "2026-08-07T16:00:00.000Z"
    },
    "signature": "a91c…", "algorithm": "HMAC-SHA256"
  }
}
```

**Response headers**

| header | meaning |
|---|---|
| `X-PAYMENT-RESPONSE` | base64 JSON `{ success, rail, network, transaction, payer, amount, asset, resource }` |
| `X-Hold-Id` | Ledger id of the hold opened for this request |

### `GET /holds/:id` — free

```jsonc
{ "hold": { "id": "hold_9f0c…", "status": "captured", "payer": "0x9a…",
            "amountUsd": 0.01, "rail": "evm", "network": "base-sepolia",
            "settled": true, "refundableUntil": "…", "artifact": { … } } }
```

`status` ∈ `held` · `captured` · `settled` · `refunded` · `voided`. **404** `{ "error": "HOLD_NOT_FOUND", "holdId": "…" }` for unknown ids.

### `POST /verify` — free

```jsonc
// request
{ "payload": { "type": "refund", "holdId": "hold_9f0c…", … }, "signature": "a91c…" }
// response
{ "valid": true }
```

Constant-time HMAC check over the canonical JSON form of `payload`. **400** `{ "error": "BAD_REQUEST" }` if either field is missing.

### `GET /health` — free

```jsonc
{ "ok": true, "service": "x402-refund-hold",
  "rails": [ { "rail": "evm", "network": "base-sepolia", "payTo": "0x40…", "facilitator": "https://x402.org/facilitator" },
             { "rail": "solana", "network": "solana", "payTo": "Wwwu…", "facilitator": "https://facilitator.payai.network" } ] }
```

### `GET /.well-known/x402` — free

The discovery manifest: resources, prices, output schemas, and both rails.

### Error cases

| status | body | when |
|---|---|---|
| 402 | `{ x402Version, error, accepts[] }` | No/invalid/unsupported payment. `accepts` always lists both rails. |
| 400 | `{ error: "BAD_REQUEST", hint }` | Malformed request to `/verify`. |
| 404 | `{ error: "HOLD_NOT_FOUND" }` | Unknown hold id. |
| 500 | `{ error: "no_payment_rail" }` | Neither rail has a valid payTo. Server misconfiguration. |
| 502 | `{ error: "facilitator_unreachable" \| "settlement_error" }` | Facilitator down. You were **not** charged; retry. |

---

## Library API

```ts
import {
  paywall, refundHold, RefundLedger,
  createUsdcRefundExecutor, createSolanaUsdcRefundExecutor,
  createDualRailRefundExecutor, executorFromEnv,
  sign, verify, signed, paymentReceipt,
} from "x402-refund-hold";
```

### `paywall(routePrices, options)`

Dual-rail x402 middleware.

```ts
app.use(paywall(
  { "POST /book": "$0.01", "GET /receipt/:id": "$0.001" },
  { service: "my-merchant", baseUrl: process.env.PUBLIC_BASE_URL },
));
```

- **`routePrices`** — `Record<"<METHOD> <path>", "$price">`. Paths support `:param` and `*` (one segment) and `**` (the rest). Routes absent from the map are free.
- **`options.service`** — name used in the 402 `description`.
- **`options.baseUrl`** — origin for the `resource` field when behind a proxy. Falls back to `PUBLIC_BASE_URL`, then the request's own host.

Emits a 402 with one `accepts` entry per configured rail, verifies and settles through that rail's facilitator, sets `X-PAYMENT-RESPONSE`, then calls `next()`.

### `refundHold(options)`

| option | default | meaning |
|---|---|---|
| `ledger` | file-backed `data/holds.json` | Bring your own `RefundLedger` |
| `executor` | none (claim mode) | On-chain refund strategy |
| `defaultRefundableMs` | `86_400_000` (24h) | Window opened at capture |
| `sweepIntervalMs` | `60_000` | Auto-refund sweep cadence; `0` disables |
| `onAutoRefund` | — | `(records: RefundRecord[]) => void` |

Returns the middleware, plus `.ledger` (the live ledger) and `.stop()` (clears the sweep timer — call it in tests and on shutdown).

### `req.hold` — `HoldHandle`

| member | type | notes |
|---|---|---|
| `id` | `string` | Also sent as `X-Hold-Id` |
| `payer` | `string` | EVM address or Solana pubkey |
| `amountUsd` | `number` | From the settlement receipt |
| `network` / `rail` | `string` / `"evm" \| "solana" \| "none"` | Which rail paid |
| `transaction` | `string \| null` | Base tx hash or Solana signature |
| `settled` | `boolean` | Whether payment actually cleared |
| `capture(opts?)` | `SignedRecord<Hold>` | `{ artifact?, refundableForMs? }` |
| `refund(reason)` | `Promise<SignedRecord<RefundRecord>>` | Runs the executor if configured |
| `void(reason)` | `SignedRecord<Hold>` | **Throws if `settled`** — use `refund` there |
| `snapshot()` | `Hold \| undefined` | Current ledger state |

If the handler resolves none of these, the middleware auto-resolves on response finish: `captured` when the payment settled, `voided` when it didn't.

### `RefundLedger`

```ts
const ledger = new RefundLedger({ file: "data/holds.json" });   // or { ephemeral: true }
```

| method | returns | notes |
|---|---|---|
| `open({ resource, payer, amountUsd, network, rail?, settled?, paymentTx? })` | `Hold` | Status `held` |
| `capture(id, { artifact?, refundableForMs? })` | `Hold` | `held` → `captured` |
| `refund(id, reason, { txHash? })` | `{ hold, record }` | `held`/`captured` → `refunded` |
| `void(id, reason)` | `Hold` | `held` → `voided` |
| `settle(id)` | `Hold` | `captured` → `settled`, no longer refundable |
| `attachRefundTx(id, txHash)` | `Hold \| undefined` | Records an executed on-chain refund |
| `get(id)` / `list(filter?)` | `Hold` / `Hold[]` | `filter`: `{ status?, payer? }` |
| `sweepExpired(reason?)` | `RefundRecord[]` | Refunds captures past `refundableUntil` |
| `digest()` | `string` | HMAC over the whole ledger — tamper evidence |

Writes are atomic (temp file + rename). Invalid transitions throw `InvalidHoldStateError`; unknown ids throw `HoldNotFoundError`.

### Refund executors

```ts
createUsdcRefundExecutor({ privateKey, network?, rpcUrl? })        // Base / Base Sepolia, ERC-20 transfer
createSolanaUsdcRefundExecutor({ secretKey, network?, rpcUrl? })   // Solana, SPL transferChecked
createDualRailRefundExecutor({ evm?, solana? })                    // routes on hold.rail
executorFromEnv()                                                  // builds the above from env
```

`secretKey` accepts a base58 string or a JSON array of 64 bytes. A rail with no executor falls back to signed claims — `execute` throwing is caught, and the claim stands.

### Signing

```ts
sign(payload, secret?)              // hex HMAC-SHA256 over canonical JSON
verify(payload, signature, secret?) // constant-time
signed(payload)                     // { payload, signature, algorithm: "HMAC-SHA256" }
canonicalize(value)                 // deterministic JSON: keys sorted recursively
```

Secret comes from `SIGNING_SECRET`, with a public dev default. Set it in production or your records are forgeable.

### `paymentReceipt(res)`

```ts
{ success: true, rail: "evm" | "solana", network, transaction, payer, amount, asset, resource }
```

The settlement receipt for the current request — the same object encoded into `X-PAYMENT-RESPONSE`. `null` on free routes.

---

[Tutorial](./tutorial.md) · [For AI agents](./agents.md)
