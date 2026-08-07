import type { NextFunction, Request, Response } from "express";
import { RefundLedger, type Hold, type RefundRecord } from "./ledger.js";
import type { RefundExecutor } from "./executor.js";
import { paymentReceipt, type PaymentReceipt } from "./payments.js";
import { signed, type SignedRecord } from "./sign.js";

/**
 * refundHold() — drop-in Express middleware implementing the x402
 * refundable-hold pattern. Mount it AFTER the x402 paywall on any route whose
 * price should be refundable.
 *
 * The problem it solves: x402's `exact` scheme is pay-then-serve. By the time
 * your handler runs, USDC has already moved. If the thing you sold then fails
 * to materialise — no availability, upstream 500, flow timed out — you owe the
 * customer their money back, and an agent on the other end needs *proof* of
 * that, in the response, not an email three days later.
 *
 * Per request this middleware:
 *  1. Reads the settlement receipt the paywall attached (payer, amount, rail,
 *     tx hash / signature). Without one it still opens an unsettled hold, so
 *     the same code works on free/testing routes.
 *  2. Opens a `held` entry in the RefundLedger and exposes `req.hold`.
 *  3. Auto-resolves on response finish if the handler didn't:
 *     settled → `captured`; never settled → `voided`.
 *  4. Sweeps captured holds whose `refundableUntil` passed without fulfilment
 *     and auto-refunds them.
 *
 * Inside the handler, `req.hold` exposes capture/refund/void, each returning an
 * HMAC-signed record you embed in the response body — so payment always
 * produces an artifact, whether the outcome was success or a refund.
 */

export interface HoldHandle {
  /** Ledger id, also echoed in the `X-Hold-Id` response header. */
  id: string;
  /** Payer wallet recovered from the settlement receipt (EVM address or Solana pubkey). */
  payer: string;
  /** Hold amount in USD. */
  amountUsd: number;
  /** Settlement network, e.g. `base-sepolia` or `solana`. */
  network: string;
  /** Which rail actually paid. */
  rail: "evm" | "solana" | "none";
  /** Settlement transaction hash (Base) or signature (Solana), when settled. */
  transaction: string | null;
  /** True once the paywall has settled a payment for this request. */
  settled: boolean;
  /** Capture the hold: obligation delivered, refundable window opens. */
  capture(opts?: { artifact?: unknown; refundableForMs?: number }): SignedRecord<Hold>;
  /**
   * Refund the hold. Executes an on-chain USDC transfer when a RefundExecutor
   * is configured, otherwise issues a signed refund claim. Returns the signed
   * record for embedding in the response body.
   */
  refund(reason: string): Promise<SignedRecord<RefundRecord>>;
  /**
   * Void a hold whose payment never settled — nothing to send back. Throws if
   * the payment *did* settle: use {@link refund} there, or the customer is out
   * of pocket with no record.
   */
  void(reason: string): SignedRecord<Hold>;
  /** Current ledger snapshot for this hold. */
  snapshot(): Hold | undefined;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      hold?: HoldHandle;
    }
  }
}

export interface RefundHoldOptions {
  /** Ledger instance. Default: file-backed ledger at `data/holds.json`. */
  ledger?: RefundLedger;
  /** On-chain refund executor. Omit for signed refund claims. */
  executor?: RefundExecutor;
  /** Default refundable window applied at capture. Default: 24h. */
  defaultRefundableMs?: number;
  /** Sweep interval for expired refundable captures. `0` disables. Default: 60s. */
  sweepIntervalMs?: number;
  /** Called whenever a sweep issues automatic refunds. */
  onAutoRefund?: (records: RefundRecord[]) => void;
}

export interface RefundHoldMiddleware {
  (req: Request, res: Response, next: NextFunction): void;
  /** The ledger these holds are written to — query it from free routes. */
  ledger: RefundLedger;
  /** Stop the background sweep timer (graceful shutdown / tests). */
  stop(): void;
}

/** What the middleware learned about the payment behind this request. */
export interface HoldPayment {
  payer: string;
  amountUsd: number;
  network: string;
  rail: "evm" | "solana" | "none";
  transaction: string | null;
  settled: boolean;
}

/**
 * Read the payment behind a request: the paywall's settlement receipt when
 * present, otherwise a best-effort decode of the raw `X-PAYMENT` header (which
 * is all that's available if payment is settled downstream of this middleware).
 */
export function readPayment(req: Request, res: Response): HoldPayment {
  const receipt = paymentReceipt(res) as PaymentReceipt | null;
  if (receipt) {
    return {
      payer: receipt.payer ?? "unknown",
      amountUsd: Number(receipt.amount) / 1e6,
      network: receipt.network,
      rail: receipt.rail,
      transaction: receipt.transaction,
      settled: true,
    };
  }
  return { ...decodePaymentHeader(req.header("X-PAYMENT")), transaction: null, settled: false };
}

/** Best-effort decode of the base64 `X-PAYMENT` header (both rails). */
export function decodePaymentHeader(
  header: string | undefined,
): Pick<HoldPayment, "payer" | "amountUsd" | "network" | "rail"> {
  if (!header) return { payer: "unknown", amountUsd: 0, network: "unknown", rail: "none" };
  try {
    const parsed = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as {
      network?: string;
      payload?: { authorization?: { from?: string; value?: string }; signer?: string; transaction?: string };
    };
    const network = parsed.network ?? "unknown";
    const auth = parsed.payload?.authorization;
    return {
      // EVM `exact` carries an EIP-3009 authorization; Solana `exact` carries a
      // signed transaction whose signer is the payer.
      payer: auth?.from ?? parsed.payload?.signer ?? "unknown",
      amountUsd: auth?.value ? Number(auth.value) / 1e6 : 0,
      network,
      rail: network.startsWith("solana") ? "solana" : "evm",
    };
  } catch {
    return { payer: "unknown", amountUsd: 0, network: "unknown", rail: "none" };
  }
}

export function refundHold(options: RefundHoldOptions = {}): RefundHoldMiddleware {
  const ledger = options.ledger ?? new RefundLedger();
  const defaultRefundableMs = options.defaultRefundableMs ?? 24 * 60 * 60 * 1000;
  const sweepIntervalMs = options.sweepIntervalMs ?? 60_000;

  let timer: ReturnType<typeof setInterval> | undefined;
  if (sweepIntervalMs > 0) {
    timer = setInterval(() => {
      void (async () => {
        const records = ledger.sweepExpired();
        for (const record of records) await executeRefund(record);
        if (records.length && options.onAutoRefund) options.onAutoRefund(records);
      })();
    }, sweepIntervalMs);
    timer.unref?.();
  }

  /** Run the configured executor for a refund record, if any. */
  async function executeRefund(record: RefundRecord): Promise<RefundRecord> {
    if (!options.executor || record.txHash) return record;
    try {
      const hold = ledger.get(record.holdId);
      if (!hold) return record;
      const { txHash } = await options.executor.execute(hold);
      record.txHash = txHash;
      record.mode = "onchain";
      ledger.attachRefundTx(record.holdId, txHash);
    } catch {
      // Execution failed — the signed claim stands; the merchant retries it
      // out-of-band. Never throw here: the customer still gets their record.
    }
    return record;
  }

  const middleware = ((req: Request, res: Response, next: NextFunction) => {
    const payment = readPayment(req, res);
    const hold = ledger.open({
      resource: `${req.method} ${req.path}`,
      payer: payment.payer,
      amountUsd: payment.amountUsd,
      network: payment.network,
      rail: payment.rail,
      settled: payment.settled,
      paymentTx: payment.transaction ?? undefined,
    });
    res.setHeader("X-Hold-Id", hold.id);

    let resolved = false;

    const handle: HoldHandle = {
      id: hold.id,
      payer: payment.payer,
      amountUsd: payment.amountUsd,
      network: payment.network,
      rail: payment.rail,
      transaction: payment.transaction,
      settled: payment.settled,
      capture(opts = {}) {
        resolved = true;
        return signed(
          ledger.capture(hold.id, {
            artifact: opts.artifact,
            refundableForMs: opts.refundableForMs ?? defaultRefundableMs,
          }),
        );
      },
      async refund(reason: string) {
        resolved = true;
        const { record } = ledger.refund(hold.id, reason);
        await executeRefund(record);
        return signed(record);
      },
      void(reason: string) {
        if (payment.settled) {
          throw new Error(
            `Hold ${hold.id} was paid (${payment.network} ${payment.transaction ?? ""}) — void would strand the ` +
              `customer's funds. Call refund() instead.`,
          );
        }
        resolved = true;
        return signed(ledger.void(hold.id, reason));
      },
      snapshot() {
        return ledger.get(hold.id);
      },
    };

    req.hold = handle;

    res.on("finish", () => {
      if (resolved) return;
      const current = ledger.get(hold.id);
      if (!current || current.status !== "held") return;
      if (payment.settled) {
        // Money moved and the handler said nothing — capture, which starts the
        // refundable window so the sweep can still make the customer whole.
        ledger.capture(hold.id, { refundableForMs: defaultRefundableMs });
      } else {
        ledger.void(hold.id, `no settlement recorded (response status ${res.statusCode})`);
      }
    });

    next();
  }) as RefundHoldMiddleware;

  middleware.ledger = ledger;
  middleware.stop = () => {
    if (timer) clearInterval(timer);
  };

  return middleware;
}
