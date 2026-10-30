// Recorded, verified mainnet evidence (read-only, for display). These are real
// on-chain facts from the ZecOne mainnet pilot; no values are fabricated.
export const EVIDENCE = {
  zcashDeposit: {
    txid: "8f512d50e1ee36eb222537bdba8b8f762f39256e28259a422913392d86b5f86c",
    zatoshis: "645937",
    zec: "0.00645937",
    block: 3529711,
  },
  basePayout: {
    txHash: "0xc677e9fa956015732c79bfda0991369245bae9394b6f0b9e13425a8e247648a7",
    wei: "3284955372432969",
    eth: "0.003284955372432969",
    block: 53065894,
  },
  zcashWithdrawal: {
    txid: "0316e2140f5a3440c2755e3f92c748a5f215d509d690d52b4858bfcc9a8af02f",
    sentZat: "100000",
    feeZat: "10000",
    changeZat: "535937",
    block: 3531047,
  },
  zcashExecutionTest: {
    txid: "0f0e944238b7649fa927876875011cc97ea7972eeb8da6ba445898ce3c1def47",
    sentZat: "10000",
    feeZat: "10000",
    changeZat: "515937",
    block: 3533388,
    finalityThreshold: 10,
    confirmationsAtVerification: 11,
    status: "FINALIZED",
  },
} as const;

export const zcashTx = (txid: string) => `https://zcashblockexplorer.com/transactions/${txid}`;
export const baseTx = (txHash: string) => `https://basescan.org/tx/${txHash}`;

export const CHECKOUT_ADDRESS =
  "u1qqq8z5wnpx5yft50ahvm2cq3rzumnszs2r53ccruhnk4xrv3su4wtgxwvwz5chqfv8l2v7atn83kdjcfmp9lpaf7clwu32yufqhf4eah6r0k5dvxq85nc8ky2keej6cz9wlr8aflajelgsy4s8nj8j3s388t4l9zejcfe5dcevdmnyr2";
