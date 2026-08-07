# For AI agents — x402-refund-hold

How an autonomous agent finds this service, pays it, and knows what it bought.

---

## 1. Discovery

Two files describe the service to a machine, both served by the running app and committed in the repo:

| what | where | for |
|---|---|---|
| `skill.md` | repo root, or `https://raw.githubusercontent.com/nirholas/x402-refund-hold/main/skill.md` | Drop into an agent's context: endpoints, prices, response shapes, error codes |
| `/.well-known/x402` | `<BASE_URL>/.well-known/x402` | Machine-readable manifest — resources, prices, output schemas, both rails |
| `openapi.json` | repo root | OpenAPI 3.1 including the 402 response and `PaymentRequirements` schema |

Fetching the manifest is the cheapest way to learn what a deployment sells:

```bash
curl -s https://your-deployment.example.com/.well-known/x402 | jq '.resources[] | {resource, price}'
```

## 2. Paying — either rail

Every 402 from this service lists **both** rails. Your client picks whichever wallet it holds; the server settles through the facilitator for that rail.

```jsonc
{
  "x402Version": 1,
  "error": "X-PAYMENT header is required",
  "accepts": [
    { "scheme": "exact", "network": "base-sepolia", "maxAmountRequired": "10000",
      "payTo": "0x40252CFDF8B20Ed757D61ff157719F33Ec332402",
      "asset": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      "extra": { "name": "USDC", "version": "2" } },
    { "scheme": "exact", "network": "solana", "maxAmountRequired": "10000",
      "payTo": "WwwuGbqHrwF5RG89KhUbmRWEvjnRH9k5kVM5p7T3WwW",
      "asset": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      "extra": { "name": "USD Coin", "decimals": 6, "feePayer": "2wKup…" } }
  ]
}
```

**Base / EVM** — sign an EIP-3009 `transferWithAuthorization`. `x402-fetch` handles it:

```ts
import { wrapFetchWithPayment } from "x402-fetch";
import { privateKeyToAccount } from "viem/accounts";

const pay = wrapFetchWithPayment(fetch, privateKeyToAccount(process.env.PRIVATE_KEY));
const res = await pay(`${BASE}/demo/book`, {
  method: "POST", headers: { "content-type": "application/json" }, body: "{}",
});
```

**Solana** — build an SPL USDC `transferChecked` to `payTo`, sign it, and send the base64 x402 payload in `X-PAYMENT`. `extra.feePayer` is the facilitator's sponsor account: it pays the SOL network fee, so your wallet needs **only USDC, no SOL**.

```ts
import { prepareSolanaCheckout, encodeX402Payment } from "@three-ws/x402-payment-modal/server";

const accept = accepts.find(a => a.network.startsWith("solana"))!;
const { tx_base64 } = await prepareSolanaCheckout({ accept, buyer: wallet.publicKey.toBase58() });
const signedTx = await wallet.signTransaction(tx_base64);
const { x_payment } = encodeX402Payment({ accept, signedTxBase64: signedTx, resourceUrl });
```

The 200 carries `X-PAYMENT-RESPONSE` — base64 JSON with the rail, network, tx hash / signature and payer. Log it: it is your proof of what you spent.

## 3. What you actually get

The contract this service holds itself to: **payment always yields an artifact in the 200 body.** Three outcomes, one status code.

| `outcome` | you get | what to do |
|---|---|---|
| `confirmed` | `confirmation` (the booking) + signed `hold` | Store `hold.payload.id`; the booking is real |
| `refunded` | signed `refund` record | Your money is coming back — verify the signature, then retry or route elsewhere |
| `rejected` | signed `refund` record | Same, but the merchant declined rather than failed |

Never treat `refunded` as an error. It is the artifact you paid for when the booking could not happen, and it is cryptographically attributable to the merchant:

```ts
const ok = await fetch(`${BASE}/verify`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify(artifact.refund),
}).then(r => r.json());
// { valid: true } → the merchant signed this obligation
```

Check `refund.payload.mode`:

- `"onchain"` — the USDC is already moving back; `txHash` is your receipt.
- `"claim"` — the merchant owes you, recorded and signed, settled out-of-band.

## 4. Budgeting

At `$0.01` per booking attempt, a failed call costs you nothing net once the refund lands — but claims settle on the merchant's schedule. If you're running a budget-constrained agent loop, treat `mode: "claim"` refunds as receivables, not cash, and cap exposure per merchant. ([x402-agent-wallet](https://github.com/nirholas/x402-agent-wallet) does exactly this.)

## 5. MCP integration

See [`examples/mcp-tool.md`](https://github.com/nirholas/x402-refund-hold/blob/main/examples/mcp-tool.md) for a complete MCP server exposing `book_with_refund_protection` as a Claude tool, including the payment wrapper and how to surface refunds to the model.

## 6. Protocol version and schemas

Every `accepts` entry carries `outputSchema.input` (how to build the request) and
`outputSchema.output` (the JSON Schema of the 200 body), generated from
`openapi.json`. A 402 is therefore enough on its own: pay, then call the route
exactly as `input` describes and parse what `output` promises — no second fetch
of the spec required.

The challenges are **x402 v1** (`"x402Version": 1`), the version every deployed
`x402-fetch` / `x402` client speaks today, including the examples in this repo.
x402 v2 — CAIP-2 network ids, and `extensions.bazaar.schema` in place of
`accepts[].outputSchema` — is a planned future upgrade for agentcash
compatibility. Until then, a v2-only client should treat this service as v1;
nothing else about the flow changes.

## 7. Getting listed

If you deploy this, register it so other agents can find it:

- **[x402scan.com](https://x402scan.com)** — the x402 endpoint index. Point it at your `/.well-known/x402`.
- **x402 Bazaar** — the protocol's own resource directory; same manifest format.
- **[agentic.market](https://agentic.market)** — agent-facing marketplace listing.

All three read the manifest at `/.well-known/x402`, so keep it accurate: prices, `outputSchema`, and both `rails` entries.

---

[Tutorial](./tutorial.md) · [API reference](./api.md) · Contact: nichxbt@gmail.com
