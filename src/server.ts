import "dotenv/config";
import express from "express";
import { readFileSync } from "node:fs";
import { activeRails, mountSolanaCheckout, paywall, usingSuiteDefaultPayTo } from "./payments.js";
import { refundHold } from "./middleware.js";
import { ROUTE_SCHEMAS } from "./schemas.js";
import { executorFromEnv } from "./executor.js";
import { verify } from "./sign.js";
import { tryBooking, type BookingRequest } from "./service.js";

/**
 * Demo server for x402-refund-hold. The library is the primary artifact —
 * this server exists to show the middleware working end-to-end:
 *
 *   POST /demo/book   $0.01 refundable  → confirmation OR refund record, in-response
 *   GET  /holds/:id   free              → hold status from the ledger
 *   POST /verify      free              → verify any signed record issued here
 *
 * Pay in USDC on Base or Solana — the 402 advertises both rails and the client
 * picks one.
 */

const port = Number(process.env.PORT || 4031);

const app = express();
app.use(express.json());

const PRICES: Record<string, string> = {
  "POST /demo/book": "$0.01",
};

// `schemas` publishes each paid route's request/response contract inside the 402
// challenge (`accepts[].outputSchema`), so an agent that hits the paywall knows
// how to call the route and what it will get back without reading the OpenAPI
// document first. Generated from openapi.json — see src/schemas.ts.
app.use(paywall(PRICES, { service: "x402-refund-hold", schemas: ROUTE_SCHEMAS }));

const holds = refundHold({ executor: executorFromEnv() });

app.post("/demo/book", holds, async (req, res) => {
  const outcome = tryBooking((req.body ?? {}) as BookingRequest);
  const hold = req.hold!;

  if (outcome.kind === "confirmed") {
    const record = hold.capture({
      artifact: outcome.confirmation,
      refundableForMs: 24 * 60 * 60 * 1000,
    });
    res.json({
      outcome: "confirmed",
      confirmation: outcome.confirmation,
      hold: record,
      refundTerms: "Refundable for 24h via the merchant; auto-refund sweep if never fulfilled.",
    });
    return;
  }

  // Both remaining outcomes mean the booking did not happen. x402's `exact`
  // scheme is pay-then-serve, so the customer's USDC has *already* moved by the
  // time this handler runs — the only honest response is a refund, returned as
  // a signed record in the 200 body. Never a bare 4xx: that would take the
  // money and hand back nothing the agent can act on.
  const refund = await hold.refund(outcome.reason);
  res.json({
    outcome: outcome.kind === "failed" ? "refunded" : "rejected",
    reason: outcome.reason,
    refund,
  });
});

app.get("/holds/:id", (req, res) => {
  const hold = holds.ledger.get(req.params.id);
  if (!hold) {
    res.status(404).json({ error: "HOLD_NOT_FOUND", holdId: req.params.id });
    return;
  }
  res.json({ hold });
});

app.post("/verify", (req, res) => {
  const { payload, signature } = (req.body ?? {}) as { payload?: unknown; signature?: string };
  if (payload === undefined || !signature) {
    res.status(400).json({ error: "BAD_REQUEST", hint: "POST { payload, signature }" });
    return;
  }
  res.json({ valid: verify(payload, signature) });
});

app.get("/.well-known/x402", (_req, res) => {
  res.type("application/json").send(readFileSync("public/.well-known/x402", "utf8"));
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "x402-refund-hold", rails: activeRails() });
});

app.use(express.static("public"));

// Phantom needs a server-built SPL transfer; this mounts the helper endpoints.
// Skipped with a log line if the optional Solana packages are absent.
await mountSolanaCheckout(app);

app.listen(port, () => {
  console.log(`\nx402-refund-hold demo server on http://localhost:${port}`);
  console.log("\nPayment rails (client picks one):");
  for (const rail of activeRails()) {
    console.log(`  ${rail.rail.padEnd(7)} ${rail.network.padEnd(14)} USDC → ${rail.payTo}`);
  }
  if (usingSuiteDefaultPayTo()) {
    console.log("  note: using suite default payTo — set PAY_TO_ADDRESS / SOLANA_PAY_TO_ADDRESS to receive funds yourself");
  }
  console.log(
    `\nRefund mode: ${process.env.REFUND_PRIVATE_KEY ? "on-chain USDC transfers" : "signed refund claims (set REFUND_PRIVATE_KEY for on-chain)"}`,
  );
  console.log("\nPaid routes:");
  for (const [route, price] of Object.entries(PRICES)) console.log(`  ${route}  ${price} (refundable hold)`);
  console.log("\nFree routes:\n  GET /holds/:id\n  POST /verify\n  GET /.well-known/x402\n  GET /health\n");
});
