/**
 * x402-refund-hold — the refundable-hold pattern for x402 merchants, as
 * drop-in Express middleware. Works on both x402 rails: USDC on Base and USDC
 * on Solana.
 *
 * @example
 * ```ts
 * import express from "express";
 * import { paywall, refundHold, executorFromEnv } from "x402-refund-hold";
 *
 * const app = express();
 * app.use(express.json());
 *
 * // 1. Dual-rail paywall: the 402 offers Base *and* Solana; the client picks.
 * app.use(paywall({ "POST /book": "$0.01" }, { service: "my-merchant" }));
 *
 * // 2. Refundable holds on top of it.
 * const holds = refundHold({ executor: executorFromEnv() });
 *
 * app.post("/book", holds, async (req, res) => {
 *   const booking = await tryToBook(req.body);
 *   if (booking) {
 *     // Delivered: capture, and hand back the signed hold with the artifact.
 *     res.json({ outcome: "confirmed", booking, hold: req.hold!.capture({ artifact: booking }) });
 *   } else {
 *     // Failed after settlement: refund, and return the signed refund record.
 *     res.json({ outcome: "refunded", refund: await req.hold!.refund("no availability") });
 *   }
 * });
 * ```
 *
 * Every outcome — success or refund — returns a signed artifact in the 200
 * body, so a paying agent always has something verifiable to act on.
 */

export {
  refundHold,
  readPayment,
  decodePaymentHeader,
  type HoldHandle,
  type HoldPayment,
  type RefundHoldOptions,
  type RefundHoldMiddleware,
} from "./middleware.js";

export {
  RefundLedger,
  HoldNotFoundError,
  InvalidHoldStateError,
  type Hold,
  type HoldStatus,
  type RefundRecord,
  type RefundLedgerOptions,
} from "./ledger.js";

export {
  createUsdcRefundExecutor,
  createSolanaUsdcRefundExecutor,
  createDualRailRefundExecutor,
  executorFromEnv,
  USDC_ADDRESS,
  USDC_MINT,
  type RefundExecutor,
  type UsdcRefundExecutorOptions,
  type SolanaRefundExecutorOptions,
} from "./executor.js";

export {
  paywall,
  paymentReceipt,
  activeRails,
  routeMatches,
  usingSuiteDefaultPayTo,
  mountSolanaCheckout,
  DEFAULT_EVM_PAY_TO,
  DEFAULT_SOLANA_PAY_TO,
  type PaymentReceipt,
  type PaywallOptions,
  type RailInfo,
  type RoutePrices,
  type RouteSchema,
} from "./payments.js";

export { sign, verify, signed, canonicalize, type SignedRecord } from "./sign.js";
