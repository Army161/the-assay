// Shared helpers for the operational scripts. Keys never live in the repo: ADMIN_KEYPAIR points at a JSON secret key file.
import { readFileSync } from "node:fs";
import { Connection, Keypair } from "@solana/web3.js";
import { SERVER_RPC_URL, NETWORK, assertNetworkAllowed, type Network } from "../src/lib/chain";

export function loadKeypair(path = process.env.ADMIN_KEYPAIR || (NETWORK === "devnet" ? "/mnt/project-files/the-assay-secrets/devnet-admin.json" : "")) {
  if (!path) throw new Error("Set ADMIN_KEYPAIR to the key file for this network (there is no default off devnet).");
  const raw = JSON.parse(readFileSync(path, "utf8")) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

export function connection() {
  assertNetworkAllowed(NETWORK);
  return new Connection(SERVER_RPC_URL, "confirmed");
}

export const network: Network = NETWORK;

export function log(...a: unknown[]) {
  console.log(new Date().toISOString().slice(11, 19), ...a);
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
