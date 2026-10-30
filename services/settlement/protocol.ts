import {
  createHash,
  sign,
  verify,
  createPublicKey,
  type KeyObject,
} from "node:crypto";
import { getAddress, verifyMessage, type Address, type Hex } from "viem";

export const MAX_ZATOSHIS = 2_100_000_000_000_000n;
export function amount(value: unknown, positive = false): bigint {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,15})$/.test(value))
    throw Error("invalid_amount");
  const n = BigInt(value);
  if (n > MAX_ZATOSHIS || (positive && n === 0n)) throw Error("invalid_amount");
  return n;
}
export function canonical(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return JSON.stringify(value);
  if (typeof value === "number" && Number.isSafeInteger(value))
    return String(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (
    value &&
    typeof value === "object" &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((value as any)[k])}`)
      .join(",")}}`;
  throw Error("unsupported_canonical_value");
}
export const digest = (value: unknown) =>
  createHash("sha256").update(canonical(value)).digest("hex");
export function identifier(value: string) {
  if (
    !/^(?:0x[0-9a-f]{64}|[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/.test(
      value,
    )
  )
    throw Error("invalid_identifier");
}
export type RefundRequest = {
  version: 1;
  domain: "zecone-testnet-refund-v1";
  network: "zcash-testnet";
  id: string;
  orderId: string;
  intentDigest: string;
  paymentDigest: string;
  recipient: Address;
  destination: string;
  eligibleZatoshis: string;
  refundZatoshis: string;
  feeCeilingZatoshis: string;
  created: number;
  expires: number;
};
const keys = [
  "version",
  "domain",
  "network",
  "id",
  "orderId",
  "intentDigest",
  "paymentDigest",
  "recipient",
  "destination",
  "eligibleZatoshis",
  "refundZatoshis",
  "feeCeilingZatoshis",
  "created",
  "expires",
]
  .sort()
  .join(",");
export function validateRequest(r: RefundRequest, now: number) {
  if (
    !r ||
    Object.keys(r).sort().join(",") !== keys ||
    r.version !== 1 ||
    r.domain !== "zecone-testnet-refund-v1" ||
    r.network !== "zcash-testnet"
  )
    throw Error("invalid_refund_request");
  identifier(r.id);
  identifier(r.orderId);
  if (
    !/^[a-f0-9]{64}$/.test(r.intentDigest) ||
    !/^[a-f0-9]{64}$/.test(r.paymentDigest) ||
    getAddress(r.recipient) !== r.recipient
  )
    throw Error("invalid_refund_binding");
  if (
    !Number.isSafeInteger(now) ||
    !Number.isSafeInteger(r.created) ||
    !Number.isSafeInteger(r.expires) ||
    r.created > now + 5 ||
    r.expires <= now ||
    r.expires - r.created > 3600 ||
    r.expires <= r.created
  )
    throw Error("refund_expired");
  // Prefix is a transport bound only. The independent native decoder MUST also validate.
  if (
    typeof r.destination !== "string" ||
    r.destination.length > 512 ||
    !/^(utest1|ztestsapling1)[a-z0-9]+$/.test(r.destination)
  )
    throw Error("invalid_refund_destination");
  if (
    amount(r.refundZatoshis, true) + amount(r.feeCeilingZatoshis, true) >
    amount(r.eligibleZatoshis, true)
  )
    throw Error("refund_exceeds_received_payment");
}
export const userMessage = (request: RefundRequest) =>
  `ZecOne TESTNET refund request\n${canonical(request)}\nThis requests a refund only; it does not authorize EVM execution.`;
export async function verifyUser(request: RefundRequest, signature: Hex) {
  if (
    !(await verifyMessage({
      address: request.recipient,
      message: userMessage(request),
      signature,
    }))
  )
    throw Error("refund_user_authorization");
}
export type Approval = {
  role: "operator" | "signer";
  requestDigest: string;
  signature: string;
};
function approvalBytes(role: Approval["role"], request: RefundRequest) {
  return Buffer.from(
    `ZecOne independent ${role} approval v1\n${digest(request)}`,
  );
}
export function approveRequest(
  role: Approval["role"],
  request: RefundRequest,
  key: KeyObject,
): Approval {
  if (key.type !== "private" || key.asymmetricKeyType !== "ed25519")
    throw Error("invalid_approval_key");
  return {
    role,
    requestDigest: digest(request),
    signature: sign(null, approvalBytes(role, request), key).toString("hex"),
  };
}
export function verifyApproval(
  role: Approval["role"],
  request: RefundRequest,
  approval: Approval,
  publicKey: KeyObject,
) {
  if (
    publicKey.type !== "public" ||
    publicKey.asymmetricKeyType !== "ed25519" ||
    approval.role !== role ||
    approval.requestDigest !== digest(request) ||
    !/^[a-f0-9]{128}$/.test(approval.signature) ||
    !verify(
      null,
      approvalBytes(role, request),
      publicKey,
      Buffer.from(approval.signature, "hex"),
    )
  )
    throw Error(`${role}_authorization`);
}
export const publicFingerprint = (key: KeyObject) =>
  createHash("sha256")
    .update(
      (key.type === "public" ? key : createPublicKey(key)).export({
        format: "der",
        type: "spki",
      }),
    )
    .digest("hex");
