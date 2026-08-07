import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * HMAC-SHA256 signing over canonical JSON.
 *
 * Every hold, capture, void, and refund record emitted by this library is
 * signed so that a customer (or an auditor) can verify the merchant issued it.
 * The secret comes from SIGNING_SECRET; a dev default is used when unset.
 */

const DEV_SECRET = "x402-refund-hold-dev-secret-change-me";

export function signingSecret(): string {
  return process.env.SIGNING_SECRET || DEV_SECRET;
}

/** Deterministic JSON: object keys sorted recursively. */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`).join(",")}}`;
}

/** HMAC-SHA256 hex signature over the canonical JSON form of `payload`. */
export function sign(payload: unknown, secret = signingSecret()): string {
  return createHmac("sha256", secret).update(canonicalize(payload)).digest("hex");
}

/** Constant-time verification of a signature produced by {@link sign}. */
export function verify(payload: unknown, signature: string, secret = signingSecret()): boolean {
  const expected = sign(payload, secret);
  try {
    return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(signature, "hex"));
  } catch {
    return false;
  }
}

/** Wrap a payload as `{ payload, signature, algorithm }`. */
export function signed<T>(payload: T, secret = signingSecret()): SignedRecord<T> {
  return { payload, signature: sign(payload, secret), algorithm: "HMAC-SHA256" };
}

export interface SignedRecord<T> {
  payload: T;
  signature: string;
  algorithm: "HMAC-SHA256";
}
