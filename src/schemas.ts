// GENERATED from openapi.json — do not edit by hand.
//
// Per-route invocation contracts published inside the x402 402 challenge as
// `accepts[].outputSchema`. `input` tells an agent how to build the request
// (method, query/path params, JSON body fields); `output` is the JSON Schema of
// the 200 body it gets back once payment settles.
//
// Deriving these from `openapi.json` keeps the runtime challenge — which the
// x402scan discovery spec treats as authoritative — from ever contradicting the
// published spec. Regenerate whenever a paid route's parameters or response
// schema change.
//
// Keys match the paywall route map in `server.ts` exactly (`"<METHOD> <path>"`,
// with `:param` for path segments).

import type { RouteSchema } from "./payments.js";

export const ROUTE_SCHEMAS: Record<string, RouteSchema> = {
  "POST /demo/book": {
    "input": {
      "type": "http",
      "method": "POST",
      "bodyType": "json",
      "bodyFields": {
        "name": {
          "type": "string"
        },
        "time": {
          "type": "string",
          "format": "date-time"
        },
        "partySize": {
          "type": "number"
        },
        "simulate": {
          "type": "string",
          "enum": [
            "success",
            "failure",
            "reject"
          ],
          "default": "success"
        }
      }
    },
    "output": {
      "type": "object",
      "required": [
        "outcome"
      ],
      "properties": {
        "outcome": {
          "type": "string",
          "enum": [
            "confirmed",
            "refunded",
            "rejected"
          ]
        },
        "confirmation": {
          "type": "object",
          "properties": {
            "reservationId": {
              "type": "string"
            },
            "name": {
              "type": "string"
            },
            "confirmedTime": {
              "type": "string",
              "format": "date-time"
            },
            "partySize": {
              "type": "number"
            },
            "venue": {
              "type": "string"
            },
            "bookedAt": {
              "type": "string",
              "format": "date-time"
            }
          }
        },
        "hold": {
          "type": "object",
          "properties": {
            "payload": {
              "type": "object",
              "properties": {
                "id": {
                  "type": "string"
                },
                "resource": {
                  "type": "string"
                },
                "payer": {
                  "type": "string"
                },
                "amountUsd": {
                  "type": "number"
                },
                "network": {
                  "type": "string"
                },
                "rail": {
                  "type": "string",
                  "enum": [
                    "evm",
                    "solana",
                    "none"
                  ]
                },
                "settled": {
                  "type": "boolean"
                },
                "paymentTx": {
                  "type": "string"
                },
                "status": {
                  "type": "string",
                  "enum": [
                    "held",
                    "captured",
                    "voided",
                    "refunded",
                    "settled"
                  ]
                },
                "createdAt": {
                  "type": "string",
                  "format": "date-time"
                },
                "updatedAt": {
                  "type": "string",
                  "format": "date-time"
                },
                "refundableUntil": {
                  "type": "string",
                  "format": "date-time"
                },
                "reason": {
                  "type": "string"
                },
                "refundTxHash": {
                  "type": "string"
                },
                "refundMode": {
                  "type": "string",
                  "enum": [
                    "onchain",
                    "claim"
                  ]
                },
                "artifact": {}
              }
            },
            "signature": {
              "type": "string"
            },
            "algorithm": {
              "type": "string",
              "const": "HMAC-SHA256"
            }
          }
        },
        "refund": {
          "type": "object",
          "properties": {
            "payload": {
              "type": "object",
              "properties": {
                "type": {
                  "type": "string",
                  "const": "refund"
                },
                "holdId": {
                  "type": "string"
                },
                "payer": {
                  "type": "string"
                },
                "amountUsd": {
                  "type": "number"
                },
                "network": {
                  "type": "string"
                },
                "rail": {
                  "type": "string",
                  "enum": [
                    "evm",
                    "solana",
                    "none"
                  ]
                },
                "reason": {
                  "type": "string"
                },
                "mode": {
                  "type": "string",
                  "enum": [
                    "onchain",
                    "claim"
                  ]
                },
                "txHash": {
                  "type": "string"
                },
                "issuedAt": {
                  "type": "string",
                  "format": "date-time"
                }
              }
            },
            "signature": {
              "type": "string"
            },
            "algorithm": {
              "type": "string",
              "const": "HMAC-SHA256"
            }
          }
        },
        "reason": {
          "type": "string"
        },
        "refundTerms": {
          "type": "string"
        }
      }
    }
  },
};
