# Raw curl walkthrough — 402 → pay → 200

Everything below runs against `npm run dev` on `localhost:4031`. It shows the wire format with nothing hiding it.

## 1. Ask without paying

```bash
curl -i -s -X POST localhost:4031/demo/book \
  -H 'content-type: application/json' \
  -d '{"name":"Agent Guest","partySize":2}'
```

```http
HTTP/1.1 402 Payment Required
Content-Type: application/json; charset=utf-8
Access-Control-Expose-Headers: x-payment-response
```

```jsonc
{
  "x402Version": 1,
  "error": "X-PAYMENT header is required",
  "accepts": [
    {
      "scheme": "exact",
      "network": "base-sepolia",
      "maxAmountRequired": "10000",
      "resource": "http://localhost:4031/demo/book",
      "description": "x402-refund-hold: POST /demo/book",
      "mimeType": "application/json",
      "payTo": "0x40252CFDF8B20Ed757D61ff157719F33Ec332402",
      "maxTimeoutSeconds": 60,
      "asset": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      "extra": { "name": "USDC", "version": "2" }
    },
    {
      "scheme": "exact",
      "network": "solana",
      "maxAmountRequired": "10000",
      "resource": "http://localhost:4031/demo/book",
      "description": "x402-refund-hold: POST /demo/book",
      "mimeType": "application/json",
      "payTo": "WwwuGbqHrwF5RG89KhUbmRWEvjnRH9k5kVM5p7T3WwW",
      "maxTimeoutSeconds": 60,
      "asset": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      "extra": {
        "name": "USD Coin",
        "decimals": 6,
        "feePayer": "2wKupLR9q6wXYppw8Gr2NvWxKBUqm4PPJKkQfoxHDBg4",
        "amount": "10000"
      }
    }
  ]
}
```

Two `accepts` entries — Base and Solana — for the same $0.01. `maxAmountRequired` is USDC atomic units (6 decimals). Pick one.

Just the rails:

```bash
curl -s -X POST localhost:4031/demo/book -H 'content-type: application/json' -d '{}' \
  | jq -r '.accepts[] | "\(.network)\t$\(.maxAmountRequired|tonumber/1000000)\t\(.payTo)"'
```

## 2. Build the payment

Signing an EIP-3009 authorization or an SPL transfer by hand with curl is not practical — that part needs a wallet. Use `npm run client` (see [`agent-client.ts`](./agent-client.ts)), or any x402 client, to produce the header. The result is one base64 blob:

```bash
X_PAYMENT=$(node -e '…your client prints the header…')
```

Decoded, the EVM payload looks like this:

```jsonc
{
  "x402Version": 1,
  "scheme": "exact",
  "network": "base-sepolia",
  "payload": {
    "signature": "0x…",
    "authorization": {
      "from": "0x9a…", "to": "0x40252CFDF8B20Ed757D61ff157719F33Ec332402",
      "value": "10000", "validAfter": "…", "validBefore": "…", "nonce": "0x…"
    }
  }
}
```

## 3. Retry with the header

```bash
curl -i -s -X POST localhost:4031/demo/book \
  -H 'content-type: application/json' \
  -H "X-PAYMENT: $X_PAYMENT" \
  -d '{"name":"Agent Guest","partySize":2}'
```

```http
HTTP/1.1 200 OK
X-Hold-Id: hold_9f0c2c0e-1f2a-4c1e-9c0e-1f2a4c1e9c0e
X-PAYMENT-RESPONSE: eyJzdWNjZXNzIjp0cnVlLCJyYWlsIjoiZXZtIiwi…
```

```jsonc
{
  "outcome": "confirmed",
  "confirmation": { "reservationId": "resv_7f1c…", "venue": "Demo Bistro (x402-refund-hold demo)" },
  "hold": { "payload": { "id": "hold_9f0c…", "status": "captured", "rail": "evm" },
            "signature": "5f3a…", "algorithm": "HMAC-SHA256" },
  "refundTerms": "Refundable for 24h via the merchant; auto-refund sweep if never fulfilled."
}
```

Decode the receipt:

```bash
echo 'eyJzdWNjZXNzIjp0cnVlLCJyYWlsIjoiZXZtIiwi…' | base64 -d | jq
# { "success": true, "rail": "evm", "network": "base-sepolia",
#   "transaction": "0x…", "payer": "0x9a…", "amount": "10000", "asset": "0x036C…" }
```

## 4. The refund path

Same call, `simulate: "failure"`:

```bash
curl -s -X POST localhost:4031/demo/book \
  -H 'content-type: application/json' -H "X-PAYMENT: $X_PAYMENT" \
  -d '{"simulate":"failure"}' | jq
```

```jsonc
{
  "outcome": "refunded",
  "reason": "table was taken between quote and booking",
  "refund": { "payload": { "type": "refund", "holdId": "hold_…", "amountUsd": 0.01,
                           "rail": "evm", "mode": "claim" },
              "signature": "a91c…", "algorithm": "HMAC-SHA256" }
}
```

Still `200`. Verify the merchant really signed it:

```bash
curl -s -X POST localhost:4031/verify -H 'content-type: application/json' \
  -d "$(curl -s -X POST localhost:4031/demo/book -H 'content-type: application/json' \
        -H "X-PAYMENT: $X_PAYMENT" -d '{"simulate":"failure"}' | jq -c .refund)" | jq
# { "valid": true }
```

## 5. Free routes

```bash
curl -s localhost:4031/holds/hold_9f0c2c0e-… | jq .hold.status   # "captured"
curl -s localhost:4031/health | jq .rails
curl -s localhost:4031/.well-known/x402 | jq '.resources[].price'
```

## 6. Errors you'll actually hit

```bash
# Garbage payment header
curl -s -X POST localhost:4031/demo/book -H 'X-PAYMENT: not-base64' \
  -H 'content-type: application/json' -d '{}' | jq -r .error
# → invalid X-PAYMENT header: …

# Paid on a network this endpoint doesn't accept
# → unsupported rail: this endpoint does not accept exact on <network>

# Facilitator unreachable — you were NOT charged
# → 502 { "error": "facilitator_unreachable" }
```
