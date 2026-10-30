// Public mainnet address validation and ownership proof. No key generation,
// storage or signing exists here; operators supply their own addresses.
import { createPublicKey, createHash, verify } from "node:crypto";
import { getAddress, verifyMessage, zeroAddress, type Hex } from "viem";
import { publicKeyToAddress } from "viem/accounts";
import {
  address as solanaAddress,
  getAddressEncoder,
  getBase58Decoder,
  getBase58Encoder,
  type ReadonlyUint8Array,
} from "@solana/kit";
import type { ProductionNetwork } from "./production-safety.ts";

export const BASE_MAINNET_CHAIN_ID = 8453;
export const BASE_MAINNET_CAIP = "eip155:8453";
export const SOLANA_MAINNET_CAIP = "solana:mainnet";
export const SOLANA_MAINNET_GENESIS =
  "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const SOLANA_SYSTEM_PROGRAM = "11111111111111111111111111111111";
export type DestinationNetwork = "base" | "solana";

export function destinationNetwork(value: unknown): DestinationNetwork {
  if (value !== "base" && value !== "solana")
    throw Error("DESTINATION_NETWORK_REQUIRED");
  return value;
}

export function mainnetAddress(
  network: DestinationNetwork,
  value: unknown,
): string {
  if (typeof value !== "string" || !value || value.length > 100)
    throw Error("INVALID_MAINNET_ADDRESS");
  if (network === "base") {
    let parsed: string;
    try {
      parsed = getAddress(value);
    } catch {
      throw Error("INVALID_MAINNET_ADDRESS");
    }
    if (parsed === getAddress(zeroAddress))
      throw Error("INVALID_MAINNET_ADDRESS");
    return parsed;
  }
  try {
    const parsed = solanaAddress(value);
    if (parsed === SOLANA_SYSTEM_PROGRAM)
      throw Error("INVALID_MAINNET_ADDRESS");
    return parsed;
  } catch {
    throw Error("INVALID_MAINNET_ADDRESS");
  }
}

export function addressBinding(
  network: DestinationNetwork,
  value: string,
): string {
  return createHash("sha256")
    .update(`mainnet-address:${network}:${mainnetAddress(network, value)}`)
    .digest("hex");
}

export function ownershipMessage(
  network: DestinationNetwork,
  value: string,
  nonce: string,
  expires: number,
): string {
  if (!/^0x[0-9a-f]{64}$/.test(nonce) || !Number.isSafeInteger(expires))
    throw Error("INVALID_OWNERSHIP_CHALLENGE");
  return [
    "ZecOne mainnet destination ownership",
    `Network: ${network === "base" ? BASE_MAINNET_CAIP : SOLANA_MAINNET_CAIP}`,
    `Address: ${mainnetAddress(network, value)}`,
    `Binding: ${addressBinding(network, value)}`,
    `Nonce: ${nonce}`,
    `Expires: ${expires}`,
  ].join("\n");
}

// The destination owner signs the challenge with their own wallet. The service
// verifies only the public signature and never learns or stores a private key.
export async function verifyDestinationOwnership(input: {
  network: DestinationNetwork;
  address: string;
  nonce: string;
  expires: number;
  signature: string;
  now?: number;
}): Promise<{ verified: true; binding: string; message: string }> {
  const now = input.now ?? Math.floor(Date.now() / 1000);
  if (!Number.isSafeInteger(input.expires) || input.expires <= now)
    throw Error("OWNERSHIP_CHALLENGE_EXPIRED");
  if (input.expires > now + 900) throw Error("OWNERSHIP_CHALLENGE_EXPIRED");
  const value = mainnetAddress(input.network, input.address),
    message = ownershipMessage(
      input.network,
      value,
      input.nonce,
      input.expires,
    );
  if (input.network === "base") {
    if (!/^0x[0-9a-fA-F]{130}$/.test(input.signature))
      throw Error("INVALID_OWNERSHIP_SIGNATURE");
    let valid = false;
    try {
      valid = await verifyMessage({
        address: getAddress(value),
        message,
        signature: input.signature as Hex,
      });
    } catch {
      valid = false;
    }
    if (!valid) throw Error("DESTINATION_OWNERSHIP_REQUIRED");
  } else {
    let signature: ReadonlyUint8Array;
    try {
      signature = getBase58Encoder().encode(input.signature);
    } catch {
      throw Error("INVALID_OWNERSHIP_SIGNATURE");
    }
    if (signature.length !== 64) throw Error("INVALID_OWNERSHIP_SIGNATURE");
    const publicKey = getAddressEncoder().encode(
        solanaAddress(value),
      ) as Uint8Array,
      jwk = {
        kty: "OKP",
        crv: "Ed25519",
        x: Buffer.from(publicKey).toString("base64url"),
      };
    let valid = false;
    try {
      valid = verify(
        null,
        Buffer.from(message),
        createPublicKey({ key: jwk, format: "jwk" }),
        Buffer.from(signature),
      );
    } catch {
      valid = false;
    }
    if (!valid) throw Error("DESTINATION_OWNERSHIP_REQUIRED");
  }
  return {
    verified: true,
    binding: addressBinding(input.network, value),
    message,
  };
}

// Derives the relayer address from an offline signer's public key so a
// configuration typo cannot authorize a different account. Zcash remains a
// source-only network and has no destination relayer here.
export function relayerFromSigner(
  network: DestinationNetwork,
  publicKey: string,
): string {
  const key = createPublicKey(publicKey),
    jwk = key.export({ format: "jwk" }) as JsonWebKey;
  if (network === "base") {
    if (key.asymmetricKeyType !== "ec" || jwk.crv !== "secp256k1")
      throw Error("SECP256K1_SIGNER_REQUIRED");
    const x = jwk.x,
      y = jwk.y;
    if (!x || !y) throw Error("INVALID_SIGNER_PUBLIC_KEY");
    return publicKeyToAddress(
      `0x04${Buffer.from(x, "base64url").toString("hex")}${Buffer.from(
        y,
        "base64url",
      ).toString("hex")}` as Hex,
    );
  }
  if (key.asymmetricKeyType !== "ed25519")
    throw Error("ED25519_SIGNER_REQUIRED");
  if (!jwk.x) throw Error("INVALID_SIGNER_PUBLIC_KEY");
  return getBase58Decoder().decode(Buffer.from(jwk.x, "base64url")) as string;
}

export function assertSignerMatchesRelayer(
  network: DestinationNetwork,
  signerPublicKey: string,
  relayer: string,
) {
  const derived = relayerFromSigner(network, signerPublicKey);
  if (derived !== mainnetAddress(network, relayer))
    throw Error("SIGNER_RELAYER_MISMATCH");
}

export function productionNetworkAdapter(
  value: ProductionNetwork,
): DestinationNetwork {
  return destinationNetwork(value);
}
