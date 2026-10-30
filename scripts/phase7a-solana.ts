import { mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { Accounts } from "../services/solana/accounts.ts";
import { Devnet, GENESIS, json } from "../services/solana/network.ts";
import { portfolio } from "../services/solana/tokens.ts";
import { prepare } from "../services/solana/transactions.ts";
import { SolanaJournal } from "../services/solana/journal.ts";
mkdirSync(".state/phase7a", { recursive: true });
mkdirSync("docs/phase7a-evidence", { recursive: true });
for (const label of ["payer", "recipient"] as const) {
  if (!Accounts.list().some((a) => a.label === label))
    await Accounts.generate(label);
}
const accounts = Accounts.list();
console.log(json({ network: "solana:devnet", accounts }));
const net = new Devnet();
const evidence: any = {
  capturedAt: new Date().toISOString(),
  accounts,
  broadcast: false,
};
try {
  evidence.health = await net.health();
  evidence.portfolios = [];
  for (const account of accounts)
    evidence.portfolios.push(await portfolio(net, account.address));
  const owner = accounts.find((a) => a.label === "payer")!.address,
    recipient = accounts.find((a) => a.label === "recipient")!.address;
  const prepared = await prepare(
    net,
    {
      family: "solana",
      network: "solana:devnet",
      genesis: GENESIS,
      owner,
      recipient,
      amount: "1000000",
      asset: { kind: "SOL" },
      feeCap: "10000",
    },
    accounts.map((a) => a.address),
  );
  const journal = new SolanaJournal(
    new DatabaseSync(".state/phase7a/solana.sqlite"),
  );
  const id = randomUUID();
  journal.save(id, prepared);
  journal.db.close();
  evidence.dryRun = {
    id,
    action: prepared.action,
    lifetime: prepared.lifetime,
    fee: prepared.fee,
    digest: prepared.digest,
    simulation: prepared.simulation,
    state: prepared.state,
  };
} catch (e) {
  evidence.error = e instanceof Error ? e.message : "READ_FAILED";
  process.exitCode = 1;
}
writeFileSync("docs/phase7a-evidence/devnet.json", json(evidence));
console.log(json(evidence));
