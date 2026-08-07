/**
 * Full x402 flow from an agent's point of view: hit the paid route, get a 402
 * listing both rails, pay on one, read the artifact.
 *
 *   PRIVATE_KEY=0x… npx tsx examples/agent-client.ts
 *   SIMULATE=failure PRIVATE_KEY=0x… npx tsx examples/agent-client.ts
 *
 * PRIVATE_KEY is a base-sepolia wallet holding a little test USDC
 * (https://faucet.circle.com). Without it the script stops at the 402 and
 * prints the challenge, which is still the interesting half.
 */
import { privateKeyToAccount } from "viem/accounts";
import { wrapFetchWithPayment, decodeXPaymentResponse } from "x402-fetch";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:4021";
const SIMULATE = process.env.SIMULATE ?? "success";
const body = JSON.stringify({ name: "Agent Guest", partySize: 2, simulate: SIMULATE });

// ── 1. Unpaid request: see what the service accepts ─────────────────────────
const challenge = await fetch(`${BASE_URL}/demo/book`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body,
});

if (challenge.status !== 402) {
  console.error(`Expected 402, got ${challenge.status}. Is the server running?`);
  process.exit(1);
}

const requirements = (await challenge.json()) as {
  accepts: { network: string; maxAmountRequired: string; payTo: string; asset: string }[];
};

console.log("402 Payment Required — this service accepts:");
for (const accept of requirements.accepts) {
  const usd = (Number(accept.maxAmountRequired) / 1e6).toFixed(3);
  console.log(`  ${accept.network.padEnd(14)} $${usd} USDC → ${accept.payTo}`);
}

if (!process.env.PRIVATE_KEY) {
  console.log("\nSet PRIVATE_KEY (a funded base-sepolia wallet) to pay and see the artifact.");
  process.exit(0);
}

// ── 2. Pay on the EVM rail and retry ────────────────────────────────────────
// x402-fetch does the whole dance: read `accepts`, sign an EIP-3009
// authorization for the requirement it can satisfy, retry with `X-PAYMENT`.
const account = privateKeyToAccount(process.env.PRIVATE_KEY as `0x${string}`);
const payingFetch = wrapFetchWithPayment(fetch, account);

const paid = await payingFetch(`${BASE_URL}/demo/book`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body,
});

const artifact = await paid.json();
console.log(`\n${paid.status} ${paid.statusText}`);
console.log("X-Hold-Id:", paid.headers.get("x-hold-id"));

const receipt = paid.headers.get("x-payment-response");
if (receipt) console.log("X-PAYMENT-RESPONSE:", decodeXPaymentResponse(receipt));

console.log("\nArtifact:");
console.log(JSON.stringify(artifact, null, 2));

// ── 3. The refund path is not an error path ─────────────────────────────────
// With SIMULATE=failure the booking fails *after* settlement, so the 200 body
// carries `outcome: "refunded"` and a signed refund record instead of a
// confirmation. Same status code, same contract: payment always yields an
// artifact you can verify.
if ((artifact as { outcome?: string }).outcome !== "confirmed") {
  const record = (artifact as { refund?: { payload: unknown; signature: string } }).refund;
  if (record) {
    const check = await fetch(`${BASE_URL}/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(record),
    });
    console.log("\nRefund signature valid:", ((await check.json()) as { valid: boolean }).valid);
  }
}

// ── Paying on Solana instead ────────────────────────────────────────────────
//
// The same 402 also offers `network: "solana"`. A Solana client picks that
// entry, builds an SPL USDC `transferChecked` to `payTo` (the facilitator's
// `extra.feePayer` sponsors the SOL fee, so you need no SOL), signs it, and
// sends the base64 x402 payload in `X-PAYMENT`:
//
//   import { prepareSolanaCheckout, encodeX402Payment }
//     from "@three-ws/x402-payment-modal/server";
//
//   const accept = requirements.accepts.find(a => a.network === "solana")!;
//   const { tx_base64 } = await prepareSolanaCheckout({ accept, buyer: wallet.publicKey.toBase58() });
//   const signed = await wallet.signTransaction(tx_base64);          // Phantom, etc.
//   const { x_payment } = encodeX402Payment({
//     accept, signedTxBase64: signed, resourceUrl: `${BASE_URL}/demo/book`,
//   });
//   await fetch(`${BASE_URL}/demo/book`, {
//     method: "POST",
//     headers: { "content-type": "application/json", "X-PAYMENT": x_payment },
//     body,
//   });
//
// In a browser, `@three-ws/x402-payment-modal` does all of the above —
// including wallet connect — straight from the 402.
