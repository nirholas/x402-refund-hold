# Expose x402-refund-hold as an MCP tool

A small MCP server that lets Claude book through this service and — crucially — understand that a refund is a successful outcome, not a failure.

## Install

```bash
npm install @modelcontextprotocol/sdk x402-fetch viem zod
```

## The server

`mcp-refund-hold.ts`:

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { wrapFetchWithPayment, decodeXPaymentResponse } from "x402-fetch";
import { privateKeyToAccount } from "viem/accounts";
import { z } from "zod";

const BASE_URL = process.env.REFUND_HOLD_URL ?? "http://localhost:4031";

// The agent's wallet. Cap what a single call may ever sign — 0.10 USDC here.
const account = privateKeyToAccount(process.env.PRIVATE_KEY as `0x${string}`);
const pay = wrapFetchWithPayment(fetch, account, 100_000n);

const server = new McpServer({ name: "x402-refund-hold", version: "0.1.0" });

server.tool(
  "book_with_refund_protection",
  "Book a reservation behind an x402 refundable hold ($0.01 USDC). Always returns an artifact: " +
    "a confirmation when the booking succeeded, or a signed refund record when it did not. " +
    "A refund is a normal outcome — report it to the user as 'not booked, money returned', not as an error.",
  {
    name: z.string().optional().describe("Guest name on the reservation"),
    time: z.string().optional().describe("ISO-8601 requested time"),
    partySize: z.number().int().positive().optional().describe("Number of covers"),
  },
  async (args) => {
    const res = await pay(`${BASE_URL}/demo/book`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(args),
    });

    const artifact = await res.json();
    const receiptHeader = res.headers.get("x-payment-response");
    const receipt = receiptHeader ? decodeXPaymentResponse(receiptHeader) : null;

    return {
      content: [
        { type: "text", text: JSON.stringify({ ...artifact, paymentReceipt: receipt }, null, 2) },
      ],
      // Only a protocol failure is an error. A refund is a valid, paid-for result.
      isError: !res.ok,
    };
  },
);

server.tool(
  "check_hold",
  "Look up the ledger state of a refundable hold by id. Free — no payment required.",
  { holdId: z.string() },
  async ({ holdId }) => {
    const res = await fetch(`${BASE_URL}/holds/${encodeURIComponent(holdId)}`);
    return { content: [{ type: "text", text: await res.text() }], isError: !res.ok };
  },
);

server.tool(
  "verify_record",
  "Verify the HMAC signature on a hold or refund record issued by the service. Free.",
  { payload: z.unknown(), signature: z.string() },
  async ({ payload, signature }) => {
    const res = await fetch(`${BASE_URL}/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ payload, signature }),
    });
    return { content: [{ type: "text", text: await res.text() }] };
  },
);

await server.connect(new StdioServerTransport());
```

## Wire it into Claude Desktop

`claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "x402-refund-hold": {
      "command": "npx",
      "args": ["tsx", "/absolute/path/to/mcp-refund-hold.ts"],
      "env": {
        "PRIVATE_KEY": "0xYourAgentWalletKey",
        "REFUND_HOLD_URL": "http://localhost:4031"
      }
    }
  }
}
```

## Notes that matter in practice

- **Budget cap.** The third argument to `wrapFetchWithPayment` is the maximum atomic USDC a single call may sign. Set it. An agent loop with an uncapped wallet is a liability.
- **Refunds are not errors.** `isError` keys off the HTTP status, never off `outcome`. If you set `isError: true` on a refund, the model will retry a call that already gave it everything it was owed.
- **Surface the receipt.** Returning `paymentReceipt` alongside the artifact lets the model tell the user exactly what was spent and on which chain.
- **Solana wallets.** `x402-fetch` covers the EVM rail. For a Phantom-style Solana signer, build the SPL transfer with `@three-ws/x402-payment-modal/server` (see [`agent-client.ts`](./agent-client.ts)) and set the `X-PAYMENT` header yourself — the tool shape above is unchanged.
- **Free tools stay free.** `check_hold` and `verify_record` hit unpaid routes; don't route them through the paying fetch.
