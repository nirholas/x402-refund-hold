# Tutorial — x402-refund-hold

From zero to a paid call whose refund you can verify, in about five minutes.

---

## 1. Install

```bash
git clone https://github.com/nirholas/x402-refund-hold
cd x402-refund-hold
npm install
```

Node 18+ (the code uses native `fetch` and top-level `await`).

## 2. Configure

```bash
cp .env.example .env
```

You can run it as-is — `.env.example` ships with the suite's public receive addresses on both rails, so the demo works before you own anything. The only lines you'd change to get paid yourself:

```bash
PAY_TO_ADDRESS=0xYourBaseWallet
SOLANA_PAY_TO_ADDRESS=YourSolanaWallet
```

Everything else has a working default. `SIGNING_SECRET` uses a dev value until you set your own — do set it before anyone relies on the signatures.

## 3. Run the server

```bash
npm run dev
```

```
x402-refund-hold demo server on http://localhost:4021

Payment rails (client picks one):
  evm     base-sepolia   USDC → 0x40252CFDF8B20Ed757D61ff157719F33Ec332402
  solana  solana         USDC → WwwuGbqHrwF5RG89KhUbmRWEvjnRH9k5kVM5p7T3WwW
  note: using suite default payTo — set PAY_TO_ADDRESS / SOLANA_PAY_TO_ADDRESS to receive funds yourself

Refund mode: signed refund claims (set REFUND_PRIVATE_KEY for on-chain)

Paid routes:
  POST /demo/book  $0.01 (refundable hold)
```

## 4. Your first 402

```bash
curl -s -X POST localhost:4021/demo/book \
  -H 'content-type: application/json' -d '{}' | jq
```

```jsonc
{
  "x402Version": 1,
  "error": "X-PAYMENT header is required",
  "accepts": [
    { "scheme": "exact", "network": "base-sepolia", "maxAmountRequired": "10000",
      "payTo": "0x40252CFDF8B20Ed757D61ff157719F33Ec332402",
      "asset": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      "extra": { "name": "USDC", "version": "2" }, "…": "…" },
    { "scheme": "exact", "network": "solana", "maxAmountRequired": "10000",
      "payTo": "WwwuGbqHrwF5RG89KhUbmRWEvjnRH9k5kVM5p7T3WwW",
      "asset": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      "extra": { "name": "USD Coin", "decimals": 6, "feePayer": "2wKup…" }, "…": "…" }
  ]
}
```

Two entries, one per rail. `maxAmountRequired` is in USDC atomic units — `10000` = $0.01. A client reads this array, picks whichever network its wallet lives on, and signs.

## 5. Pay it

Fund a Base Sepolia wallet with test USDC from [faucet.circle.com](https://faucet.circle.com), then:

```bash
PRIVATE_KEY=0xyourTestKey npm run client
```

```
402 Payment Required — this service accepts:
  base-sepolia   $0.010 USDC → 0x40252CFDF8B20Ed757D61ff157719F33Ec332402
  solana         $0.010 USDC → WwwuGbqHrwF5RG89KhUbmRWEvjnRH9k5kVM5p7T3WwW

200 OK
X-Hold-Id: hold_9f0c2c0e-…
X-PAYMENT-RESPONSE: { success: true, rail: 'evm', network: 'base-sepolia', transaction: '0x…', payer: '0x…' }
```

`x402-fetch` did the whole dance: read `accepts`, sign an EIP-3009 authorization, retry with the `X-PAYMENT` header.

## 6. Read the artifact

```jsonc
{
  "outcome": "confirmed",
  "confirmation": { "reservationId": "resv_…", "venue": "Demo Bistro (x402-refund-hold demo)", "…": "…" },
  "hold": {
    "payload": { "id": "hold_…", "status": "captured", "rail": "evm",
                 "paymentTx": "0x…", "refundableUntil": "2026-08-08T…" },
    "signature": "5f3a…", "algorithm": "HMAC-SHA256"
  },
  "refundTerms": "Refundable for 24h via the merchant; auto-refund sweep if never fulfilled."
}
```

Check the ledger independently:

```bash
curl -s localhost:4021/holds/hold_9f0c2c0e-… | jq .hold.status   # "captured"
```

## 7. Now make it fail

The interesting half. `simulate: "failure"` makes the booking fail *after* the payment settles:

```bash
SIMULATE=failure PRIVATE_KEY=0xyourTestKey npm run client
```

```jsonc
{
  "outcome": "refunded",
  "reason": "table was taken between quote and booking",
  "refund": {
    "payload": { "type": "refund", "holdId": "hold_…", "amountUsd": 0.01,
                 "rail": "evm", "mode": "claim", "issuedAt": "…" },
    "signature": "a91c…", "algorithm": "HMAC-SHA256"
  }
}
```

Still `200`. Still an artifact. The example script then calls `/verify` with that record and prints `Refund signature valid: true` — the customer can prove, unilaterally, that you owe them $0.01.

`mode: "claim"` means the refund is recorded but not yet on-chain. To make refunds move real money, add a funded refund wallet:

```bash
REFUND_PRIVATE_KEY=0x…            # refunds Base payments
SOLANA_REFUND_SECRET_KEY=…        # refunds Solana payments
```

Now the same call returns `mode: "onchain"` with a `txHash`.

## 8. The auto-refund sweep

`capture()` opens a refundable window (24h by default). A background timer refunds any captured hold whose window expires without being finalised with `ledger.settle(id)`. That is the "auto-refund if never served" guarantee, and it survives your process forgetting about the request:

```ts
const holds = refundHold({
  defaultRefundableMs: 60 * 60 * 1000,     // 1h window
  sweepIntervalMs: 30_000,                 // check twice a minute
  onAutoRefund: (records) => console.log(`auto-refunded ${records.length} holds`),
});
```

## 9. Use it in your own server

```ts
import express from "express";
import { paywall, refundHold, executorFromEnv } from "x402-refund-hold";

const app = express();
app.use(express.json());
app.use(paywall({ "POST /book": "$0.01" }, { service: "my-merchant" }));

const holds = refundHold({ executor: executorFromEnv() });

app.post("/book", holds, async (req, res) => {
  try {
    const booking = await realBookingApi(req.body);
    res.json({ outcome: "confirmed", booking, hold: req.hold!.capture({ artifact: booking }) });
  } catch (err) {
    res.json({ outcome: "refunded", refund: await req.hold!.refund(String(err)) });
  }
});
```

Two rules keep you honest:

1. **Never return a bare 4xx/5xx from a paid route.** The money already moved; the caller must get a refund record.
2. **Never call `void()` on a settled hold.** It throws on purpose — `void` is only for payments that never cleared.

## 10. Going to mainnet

```bash
NETWORK=base
SOLANA_NETWORK=mainnet-beta
FACILITATOR_URL=https://facilitator.payai.network       # settles Base mainnet
SOLANA_FACILITATOR_URL=https://facilitator.payai.network
PAY_TO_ADDRESS=0xYourRealWallet
SOLANA_PAY_TO_ADDRESS=YourRealSolanaWallet
SIGNING_SECRET=$(openssl rand -hex 32)
```

Checklist before real money:

- Set `SIGNING_SECRET` — otherwise your refund records are signed with a public dev key and anyone can forge one.
- Fund the refund wallets on both rails, or accept that refunds stay claims.
- Persist `data/holds.json` (a volume, not a container layer).
- Point `PUBLIC_BASE_URL` at your real origin so the `resource` field in each 402 matches the URL clients actually call — facilitators check it.

---

Next: [API reference](./api.md) · [For AI agents](./agents.md)
