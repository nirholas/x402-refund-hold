import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { sign } from "./sign.js";

/**
 * RefundLedger — file-backed ledger of x402 refundable holds.
 *
 * Lifecycle:
 *
 *   held ──▶ captured ──▶ settled            (merchant delivered, hold finalized)
 *     │          │
 *     │          └──────▶ refunded           (post-settlement failure → refund)
 *     │
 *     └─────────────────▶ voided             (in-request failure → x402 never settles,
 *                                             the customer was never charged)
 *
 * "voided" is the cheap failure path unique to x402: the payment middleware only
 * settles on-chain when the response status is < 400, so a handler that fails
 * before responding 200 costs the customer nothing. "refunded" covers failures
 * discovered after money moved.
 */

export type HoldStatus = "held" | "captured" | "voided" | "refunded" | "settled";

export interface Hold {
  id: string;
  resource: string;
  payer: string;
  amountUsd: number;
  network: string;
  /** Which x402 rail paid: Base/EVM, Solana, or none (unsettled). */
  rail: "evm" | "solana" | "none";
  /** True once the x402 paywall settled a payment for this request. */
  settled: boolean;
  /** Settlement tx hash (Base) or transaction signature (Solana). */
  paymentTx?: string;
  status: HoldStatus;
  createdAt: string;
  updatedAt: string;
  /** ISO timestamp until which a captured hold remains refundable. */
  refundableUntil?: string;
  /** Reason recorded on void/refund. */
  reason?: string;
  /** On-chain refund transaction hash, when a RefundExecutor is configured. */
  refundTxHash?: string;
  /** How the refund was (or will be) executed. */
  refundMode?: "onchain" | "claim";
  /** Arbitrary artifact attached at capture time (e.g. a booking confirmation). */
  artifact?: unknown;
}

export interface RefundRecord {
  type: "refund";
  holdId: string;
  payer: string;
  amountUsd: number;
  network: string;
  /** The rail the original payment arrived on — refunds go back the same way. */
  rail: "evm" | "solana" | "none";
  reason: string;
  mode: "onchain" | "claim";
  txHash?: string;
  issuedAt: string;
}

export interface RefundLedgerOptions {
  /** JSON file used for persistence. Default: data/holds.json */
  file?: string;
  /** Disable persistence entirely (in-memory only). */
  ephemeral?: boolean;
}

export class RefundLedger {
  private holds = new Map<string, Hold>();
  private readonly file: string;
  private readonly ephemeral: boolean;

  constructor(options: RefundLedgerOptions = {}) {
    this.file = options.file ?? "data/holds.json";
    this.ephemeral = options.ephemeral ?? false;
    this.load();
  }

  /** Open a new hold in `held` state. */
  open(input: {
    resource: string;
    payer: string;
    amountUsd: number;
    network: string;
    rail?: "evm" | "solana" | "none";
    settled?: boolean;
    paymentTx?: string;
  }): Hold {
    const now = new Date().toISOString();
    const hold: Hold = {
      id: `hold_${randomUUID()}`,
      resource: input.resource,
      payer: input.payer,
      amountUsd: input.amountUsd,
      network: input.network,
      rail: input.rail ?? "none",
      settled: input.settled ?? false,
      paymentTx: input.paymentTx,
      status: "held",
      createdAt: now,
      updatedAt: now,
    };
    this.holds.set(hold.id, hold);
    this.save();
    return hold;
  }

  /** Mark a hold captured (payment settled, obligation open). */
  capture(id: string, opts: { artifact?: unknown; refundableForMs?: number } = {}): Hold {
    const hold = this.mustGet(id, ["held"]);
    hold.status = "captured";
    hold.updatedAt = new Date().toISOString();
    if (opts.artifact !== undefined) hold.artifact = opts.artifact;
    if (opts.refundableForMs !== undefined) {
      hold.refundableUntil = new Date(Date.now() + opts.refundableForMs).toISOString();
    }
    this.save();
    return { ...hold };
  }

  /**
   * Void a hold that never settled (handler responded >= 400 before x402
   * settlement). The customer was never charged; nothing to send back.
   */
  void(id: string, reason: string): Hold {
    const hold = this.mustGet(id, ["held"]);
    hold.status = "voided";
    hold.reason = reason;
    hold.updatedAt = new Date().toISOString();
    this.save();
    return { ...hold };
  }

  /**
   * Refund a settled hold. Returns a RefundRecord describing either the
   * executed on-chain transfer (when an executor ran) or a signed refund
   * claim the merchant must settle out-of-band.
   */
  refund(id: string, reason: string, execution?: { txHash?: string }): { hold: Hold; record: RefundRecord } {
    const hold = this.mustGet(id, ["held", "captured"]);
    hold.status = "refunded";
    hold.reason = reason;
    hold.refundTxHash = execution?.txHash;
    hold.refundMode = execution?.txHash ? "onchain" : "claim";
    hold.updatedAt = new Date().toISOString();
    this.save();
    const record: RefundRecord = {
      type: "refund",
      holdId: hold.id,
      payer: hold.payer,
      amountUsd: hold.amountUsd,
      network: hold.network,
      rail: hold.rail,
      reason,
      mode: hold.refundMode!,
      txHash: hold.refundTxHash,
      issuedAt: hold.updatedAt,
    };
    return { hold: { ...hold }, record };
  }

  /** Finalize a captured hold — obligation delivered, no longer refundable. */
  settle(id: string): Hold {
    const hold = this.mustGet(id, ["captured"]);
    hold.status = "settled";
    hold.updatedAt = new Date().toISOString();
    this.save();
    return { ...hold };
  }

  /** Attach an on-chain refund tx to a hold after the executor ran. */
  attachRefundTx(id: string, txHash: string): Hold | undefined {
    const hold = this.holds.get(id);
    if (!hold) return undefined;
    hold.refundTxHash = txHash;
    hold.refundMode = "onchain";
    hold.updatedAt = new Date().toISOString();
    this.save();
    return { ...hold };
  }

  get(id: string): Hold | undefined {
    const hold = this.holds.get(id);
    return hold ? { ...hold } : undefined;
  }

  list(filter?: { status?: HoldStatus; payer?: string }): Hold[] {
    return [...this.holds.values()]
      .filter((h) => (filter?.status ? h.status === filter.status : true))
      .filter((h) => (filter?.payer ? h.payer.toLowerCase() === filter.payer.toLowerCase() : true))
      .map((h) => ({ ...h }));
  }

  /**
   * Find captured holds whose refundableUntil deadline has passed and refund
   * them. Used by the middleware's sweep timer ("auto-refund if never served").
   * Returns the refund records issued.
   */
  sweepExpired(reason = "hold expired before fulfilment"): RefundRecord[] {
    const now = Date.now();
    const records: RefundRecord[] = [];
    for (const hold of this.holds.values()) {
      if (hold.status === "captured" && hold.refundableUntil && Date.parse(hold.refundableUntil) < now) {
        records.push(this.refund(hold.id, reason).record);
      }
    }
    return records;
  }

  /** Ledger integrity digest — HMAC over the full canonical ledger contents. */
  digest(): string {
    return sign(this.list());
  }

  private mustGet(id: string, allowed: HoldStatus[]): Hold {
    const hold = this.holds.get(id);
    if (!hold) throw new HoldNotFoundError(id);
    if (!allowed.includes(hold.status)) {
      throw new InvalidHoldStateError(id, hold.status, allowed);
    }
    return hold;
  }

  private load(): void {
    if (this.ephemeral || !existsSync(this.file)) return;
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8")) as Hold[];
      for (const hold of raw) this.holds.set(hold.id, hold);
    } catch {
      // Corrupt or empty file — start fresh rather than crash.
    }
  }

  private save(): void {
    if (this.ephemeral) return;
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify([...this.holds.values()], null, 2));
    renameSync(tmp, this.file);
  }
}

export class HoldNotFoundError extends Error {
  constructor(public readonly holdId: string) {
    super(`Hold not found: ${holdId}`);
    this.name = "HoldNotFoundError";
  }
}

export class InvalidHoldStateError extends Error {
  constructor(
    public readonly holdId: string,
    public readonly actual: HoldStatus,
    public readonly expected: HoldStatus[],
  ) {
    super(`Hold ${holdId} is "${actual}", expected one of: ${expected.join(", ")}`);
    this.name = "InvalidHoldStateError";
  }
}
