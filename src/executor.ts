import type { Hold } from "./ledger.js";

/**
 * RefundExecutor — pluggable strategy for actually moving USDC back to the
 * payer when a hold is refunded.
 *
 * With no executor configured, refunds are issued as *signed refund claims*:
 * the ledger records the obligation, the record is HMAC-signed, and the
 * merchant settles it out-of-band. That is the right default for a demo and
 * for merchants who batch payouts.
 *
 * Configure a key and refunds become real on-chain USDC transfers, on the same
 * rail the customer paid on:
 *   - `REFUND_PRIVATE_KEY`         → Base / Base Sepolia (viem, ERC-20 transfer)
 *   - `SOLANA_REFUND_SECRET_KEY`   → Solana (SPL transfer, base58 or JSON array)
 */
export interface RefundExecutor {
  execute(hold: Hold): Promise<{ txHash: string }>;
}

/** Canonical USDC contract addresses per EVM network. */
export const USDC_ADDRESS: Record<string, `0x${string}`> = {
  "base-sepolia": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  base: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
};

/** Canonical USDC SPL mints per Solana cluster. */
export const USDC_MINT: Record<string, string> = {
  solana: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "solana-devnet": "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
};

const ERC20_TRANSFER_ABI = [
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

/** USDC has 6 decimals on both rails, so one conversion serves both. */
function atomicUsdc(amountUsd: number): bigint {
  return BigInt(Math.round(amountUsd * 1e6));
}

export interface UsdcRefundExecutorOptions {
  /** Hex private key of the merchant refund wallet. */
  privateKey: `0x${string}`;
  /** `base-sepolia` (default) or `base`. */
  network?: "base-sepolia" | "base";
  /** Override the RPC URL (defaults to viem's public RPC for the chain). */
  rpcUrl?: string;
}

/**
 * EVM refunds: send the held USDC back to the payer with an ERC-20 transfer on
 * Base / Base Sepolia. viem is imported lazily so claim-mode deployments never
 * pay the import cost.
 */
export function createUsdcRefundExecutor(options: UsdcRefundExecutorOptions): RefundExecutor {
  const network = options.network ?? "base-sepolia";
  const usdc = USDC_ADDRESS[network];
  if (!usdc) throw new Error(`Unsupported network for USDC refunds: ${network}`);

  return {
    async execute(hold: Hold): Promise<{ txHash: string }> {
      const { createWalletClient, http } = await import("viem");
      const { privateKeyToAccount } = await import("viem/accounts");
      const chains = await import("viem/chains");
      const chain = network === "base" ? chains.base : chains.baseSepolia;
      const account = privateKeyToAccount(options.privateKey);
      const client = createWalletClient({ account, chain, transport: http(options.rpcUrl) });
      const txHash = await client.writeContract({
        address: usdc,
        abi: ERC20_TRANSFER_ABI,
        functionName: "transfer",
        args: [hold.payer as `0x${string}`, atomicUsdc(hold.amountUsd)],
      });
      return { txHash };
    },
  };
}

export interface SolanaRefundExecutorOptions {
  /** Merchant refund keypair: base58 secret key, or a JSON array of 64 bytes. */
  secretKey: string;
  /** `solana` (mainnet, default) or `solana-devnet`. */
  network?: "solana" | "solana-devnet";
  /** RPC endpoint. Defaults to the public cluster endpoint for the network. */
  rpcUrl?: string;
}

/**
 * Solana refunds: SPL `transferChecked` of USDC from the merchant's associated
 * token account back to the payer's. Creates the payer's ATA if it doesn't
 * exist yet (the merchant pays that rent — a few thousand lamports).
 *
 * `@solana/web3.js` and `@solana/spl-token` are imported lazily for the same
 * reason as viem above.
 */
export function createSolanaUsdcRefundExecutor(options: SolanaRefundExecutorOptions): RefundExecutor {
  const network = options.network ?? "solana";
  const mint = USDC_MINT[network];
  if (!mint) throw new Error(`Unsupported Solana cluster for USDC refunds: ${network}`);
  const rpcUrl =
    options.rpcUrl ??
    (network === "solana-devnet" ? "https://api.devnet.solana.com" : "https://api.mainnet-beta.solana.com");

  return {
    async execute(hold: Hold): Promise<{ txHash: string }> {
      const { Connection, Keypair, PublicKey } = await import("@solana/web3.js");
      const { getOrCreateAssociatedTokenAccount, transferChecked } = await import("@solana/spl-token");

      const secret = options.secretKey.trim();
      const payer = secret.startsWith("[")
        ? Keypair.fromSecretKey(Uint8Array.from(JSON.parse(secret) as number[]))
        : Keypair.fromSecretKey(bs58Decode(secret));

      const connection = new Connection(rpcUrl, "confirmed");
      const mintKey = new PublicKey(mint);
      const from = await getOrCreateAssociatedTokenAccount(connection, payer, mintKey, payer.publicKey);
      const to = await getOrCreateAssociatedTokenAccount(connection, payer, mintKey, new PublicKey(hold.payer));

      const signature = await transferChecked(
        connection,
        payer,
        from.address,
        mintKey,
        to.address,
        payer,
        atomicUsdc(hold.amountUsd),
        6,
      );
      return { txHash: signature };
    },
  };
}

/**
 * Routes each refund to the rail the customer paid on. Holds whose rail has no
 * configured executor fall back to signed refund claims.
 */
export function createDualRailRefundExecutor(parts: {
  evm?: RefundExecutor;
  solana?: RefundExecutor;
}): RefundExecutor {
  return {
    async execute(hold: Hold): Promise<{ txHash: string }> {
      const executor = hold.rail === "solana" ? parts.solana : parts.evm;
      if (!executor) {
        throw new Error(
          `No on-chain refund executor configured for the ${hold.rail} rail — issuing a signed claim instead.`,
        );
      }
      return executor.execute(hold);
    },
  };
}

/**
 * Build an executor from the environment, or return undefined for claim mode.
 * Reads `REFUND_PRIVATE_KEY`, `SOLANA_REFUND_SECRET_KEY`, `NETWORK`,
 * `SOLANA_NETWORK` and `SOLANA_RPC_URL`.
 */
export function executorFromEnv(): RefundExecutor | undefined {
  const evmKey = process.env.REFUND_PRIVATE_KEY;
  const solanaKey = process.env.SOLANA_REFUND_SECRET_KEY;
  if (!evmKey && !solanaKey) return undefined;

  return createDualRailRefundExecutor({
    evm: evmKey
      ? createUsdcRefundExecutor({
          privateKey: evmKey as `0x${string}`,
          network: process.env.NETWORK === "base" ? "base" : "base-sepolia",
        })
      : undefined,
    solana: solanaKey
      ? createSolanaUsdcRefundExecutor({
          secretKey: solanaKey,
          network: process.env.SOLANA_NETWORK === "devnet" ? "solana-devnet" : "solana",
          rpcUrl: process.env.SOLANA_RPC_URL,
        })
      : undefined,
  });
}

/** Minimal base58 decoder — avoids pulling in another dependency for one call. */
function bs58Decode(input: string): Uint8Array {
  const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let num = 0n;
  for (const char of input) {
    const index = ALPHABET.indexOf(char);
    if (index < 0) throw new Error(`Invalid base58 character: ${char}`);
    num = num * 58n + BigInt(index);
  }
  const bytes: number[] = [];
  while (num > 0n) {
    bytes.unshift(Number(num % 256n));
    num /= 256n;
  }
  // Leading '1's in base58 encode leading zero bytes.
  for (const char of input) {
    if (char !== "1") break;
    bytes.unshift(0);
  }
  return Uint8Array.from(bytes);
}
