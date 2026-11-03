// Explicit, exact-order funding of a checkout price shortfall. This is not a
// repricing path: the authenticated Zcash payment and promised destination
// payout remain unchanged, and the operator funds only a bounded difference.
import { createHash } from "node:crypto";

const HEX64 = /^[a-f0-9]{64}$/;
const UINT = /^(?:0|[1-9][0-9]{0,30})$/;
const POSITIVE = /^[1-9][0-9]{0,30}$/;
const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

export const PILOT_SHORTFALL_POLICY =
  "single-use-exact-order-operator-shortfall-v1" as const;

export type PilotShortfallAuthorizationTerms = {
  version: 1;
  policy: typeof PILOT_SHORTFALL_POLICY;
  orderId: string;
  paymentCommitment: string;
  recipient: string;
  actualSourceZatoshis: string;
  quotedPayoutWei: string;
  maximumSubsidyWei: string;
  expires: number;
  approvalDeadline: number;
  termsDigest: string;
};

export type PilotSourceShortfall = {
  policy: typeof PILOT_SHORTFALL_POLICY;
  authorizationDigest: string;
  requiredSourceZatoshis: string;
  sourceValueWei: string;
  subsidyWei: string;
  maximumSubsidyWei: string;
};

const authorizationBody = (input: {
  orderId: string;
  paymentCommitment: string;
  recipient: string;
  actualSourceZatoshis: string;
  quotedPayoutWei: string;
  maximumSubsidyWei: string;
  expires: number;
  approvalDeadline: number;
}) => ({
  version: 1 as const,
  policy: PILOT_SHORTFALL_POLICY,
  orderId: input.orderId,
  paymentCommitment: input.paymentCommitment,
  recipient: input.recipient,
  actualSourceZatoshis: input.actualSourceZatoshis,
  quotedPayoutWei: input.quotedPayoutWei,
  maximumSubsidyWei: input.maximumSubsidyWei,
  expires: input.expires,
  approvalDeadline: input.approvalDeadline,
});

export function pilotSourceValueWei(
  numerator: string,
  denominator: string,
  sourceZatoshis: string,
) {
  if (
    !POSITIVE.test(numerator) ||
    !POSITIVE.test(denominator) ||
    !POSITIVE.test(sourceZatoshis)
  )
    throw Error("PILOT_SHORTFALL_PRICE_INVALID");
  // ETH/ZEC = numerator / denominator. This is the inverse of the existing
  // ceil(required-zatoshis) calculation and deliberately rounds source value
  // down, never understating the operator-funded difference.
  return (
    (BigInt(sourceZatoshis) * 10n ** 18n * BigInt(denominator)) /
    (BigInt(numerator) * 100000000n)
  );
}

export function pilotShortfallAuthorizationTerms(input: {
  orderId: string;
  paymentCommitment: string;
  recipient: string;
  actualSourceZatoshis: string;
  quotedPayoutWei: string;
  maximumSubsidyWei: string;
  expires: number;
  approvalDeadline: number;
  now?: number;
}): PilotShortfallAuthorizationTerms {
  const now = input.now ?? Math.floor(Date.now() / 1000);
  if (
    !/^[a-f0-9]{64}$/.test(input.orderId) ||
    !HEX64.test(input.paymentCommitment) ||
    !/^0x[0-9a-fA-F]{40}$/.test(input.recipient) ||
    !POSITIVE.test(input.actualSourceZatoshis) ||
    !POSITIVE.test(input.quotedPayoutWei) ||
    !POSITIVE.test(input.maximumSubsidyWei) ||
    !Number.isSafeInteger(input.expires) ||
    !Number.isSafeInteger(input.approvalDeadline) ||
    input.approvalDeadline <= now ||
    input.approvalDeadline > now + 600 ||
    input.expires < input.approvalDeadline + 300 ||
    input.expires > now + 7200
  )
    throw Error("PILOT_SHORTFALL_AUTHORIZATION_INVALID");
  if (BigInt(input.maximumSubsidyWei) >= BigInt(input.quotedPayoutWei))
    throw Error("PILOT_SHORTFALL_CAP_INVALID");
  const body = authorizationBody(input);
  return { ...body, termsDigest: digest(body) };
}

export const pilotShortfallApprovalText = (
  terms: PilotShortfallAuthorizationTerms,
) => `AUTHORIZE_PILOT_SHORTFALL ${terms.termsDigest}`;

export function assertPilotShortfallAuthorizationTerms(
  terms: PilotShortfallAuthorizationTerms,
  now = Math.floor(Date.now() / 1000),
) {
  const body = authorizationBody(terms);
  if (
    terms.version !== 1 ||
    terms.policy !== PILOT_SHORTFALL_POLICY ||
    !/^[a-f0-9]{64}$/.test(terms.orderId) ||
    !HEX64.test(terms.paymentCommitment) ||
    !/^0x[0-9a-fA-F]{40}$/.test(terms.recipient) ||
    !POSITIVE.test(terms.actualSourceZatoshis) ||
    !POSITIVE.test(terms.quotedPayoutWei) ||
    !POSITIVE.test(terms.maximumSubsidyWei) ||
    BigInt(terms.maximumSubsidyWei) >= BigInt(terms.quotedPayoutWei) ||
    !Number.isSafeInteger(terms.expires) ||
    !Number.isSafeInteger(terms.approvalDeadline) ||
    terms.approvalDeadline >= terms.expires ||
    terms.expires <= now ||
    digest(body) !== terms.termsDigest
  )
    throw Error("PILOT_SHORTFALL_AUTHORIZATION_INVALID");
  return terms;
}

export function authorizedPilotShortfall(
  terms: PilotShortfallAuthorizationTerms,
  price: { numerator: string; denominator: string },
  requiredSourceZatoshis: string,
  now = Math.floor(Date.now() / 1000),
): PilotSourceShortfall {
  assertPilotShortfallAuthorizationTerms(terms, now);
  if (!POSITIVE.test(requiredSourceZatoshis))
    throw Error("PILOT_SHORTFALL_PRICE_INVALID");
  const sourceValueWei = pilotSourceValueWei(
      price.numerator,
      price.denominator,
      terms.actualSourceZatoshis,
    ),
    payout = BigInt(terms.quotedPayoutWei),
    subsidy = payout > sourceValueWei ? payout - sourceValueWei : 0n;
  if (
    BigInt(requiredSourceZatoshis) <= BigInt(terms.actualSourceZatoshis) ||
    subsidy === 0n ||
    subsidy > BigInt(terms.maximumSubsidyWei)
  )
    throw Error("PILOT_SHORTFALL_NOT_AUTHORIZED");
  return {
    policy: PILOT_SHORTFALL_POLICY,
    authorizationDigest: terms.termsDigest,
    requiredSourceZatoshis,
    sourceValueWei: sourceValueWei.toString(),
    subsidyWei: subsidy.toString(),
    maximumSubsidyWei: terms.maximumSubsidyWei,
  };
}

export function assertPilotSourceShortfall(
  value: PilotSourceShortfall,
  terms: PilotShortfallAuthorizationTerms,
) {
  if (
    value.policy !== PILOT_SHORTFALL_POLICY ||
    value.authorizationDigest !== terms.termsDigest ||
    value.maximumSubsidyWei !== terms.maximumSubsidyWei ||
    !POSITIVE.test(value.requiredSourceZatoshis) ||
    !UINT.test(value.sourceValueWei) ||
    !POSITIVE.test(value.subsidyWei) ||
    BigInt(value.subsidyWei) > BigInt(value.maximumSubsidyWei)
  )
    throw Error("PILOT_SHORTFALL_TERMS_INVALID");
  return value;
}

export function validatePilotSourceShortfall(value: PilotSourceShortfall) {
  if (
    value.policy !== PILOT_SHORTFALL_POLICY ||
    !HEX64.test(value.authorizationDigest) ||
    !POSITIVE.test(value.requiredSourceZatoshis) ||
    !UINT.test(value.sourceValueWei) ||
    !POSITIVE.test(value.subsidyWei) ||
    !POSITIVE.test(value.maximumSubsidyWei) ||
    BigInt(value.subsidyWei) > BigInt(value.maximumSubsidyWei)
  )
    throw Error("PILOT_SHORTFALL_TERMS_INVALID");
  return value;
}
