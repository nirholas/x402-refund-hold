import { randomUUID } from "node:crypto";

/**
 * Demo booking service used by the demo server. Deterministic on purpose:
 * the outcome is controlled by the request so the refundable-hold flow can be
 * exercised end-to-end without any external dependency.
 */

export interface BookingRequest {
  name?: string;
  time?: string;
  partySize?: number;
  /** "success" (default) | "failure" (settle then refund) | "reject" (void before settlement) */
  simulate?: string;
}

export interface BookingConfirmation {
  reservationId: string;
  name: string;
  confirmedTime: string;
  partySize: number;
  venue: string;
  bookedAt: string;
}

export type BookingOutcome =
  | { kind: "confirmed"; confirmation: BookingConfirmation }
  | { kind: "failed"; reason: string }
  | { kind: "rejected"; reason: string };

export function tryBooking(input: BookingRequest): BookingOutcome {
  const simulate = (input.simulate ?? "success").toLowerCase();
  if (simulate === "reject") {
    return { kind: "rejected", reason: "requested time is outside opening hours" };
  }
  if (simulate === "failure") {
    return { kind: "failed", reason: "table was taken between quote and booking" };
  }
  return {
    kind: "confirmed",
    confirmation: {
      reservationId: `resv_${randomUUID()}`,
      name: input.name ?? "Agent Guest",
      confirmedTime: input.time ?? new Date(Date.now() + 3 * 3600_000).toISOString(),
      partySize: input.partySize ?? 2,
      venue: "Demo Bistro (x402-refund-hold demo)",
      bookedAt: new Date().toISOString(),
    },
  };
}
