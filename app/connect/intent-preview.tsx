import type { Intent } from "../../services/wallet/intent-model";

export default function IntentPreview({ intent }: { intent: Intent }) {
  const rows = [
    ["Operation", intent.operation],
    ["Target", intent.target],
    ["Recipient", intent.recipient ?? "Not verified"],
    ["Input", `${intent.input.amount} raw units · ${intent.input.asset}`],
    ["Output asset", intent.output.asset ?? "Not verified"],
    ["Expected output", intent.output.expected ?? "Not verified"],
    ["Minimum output", intent.output.minimum ?? "Not verified"],
    [
      "Maximum input / fee / rent",
      `${intent.maximumCost.input} / ${intent.maximumCost.networkFee ?? "Not verified"} / ${intent.maximumCost.rent} raw units`,
    ],
    ["Simulation", intent.networkRequirements.status],
    [
      "Adapter recognition",
      intent.support.recognized
        ? "Recognized shape; additional financial checks required"
        : "Unsupported",
    ],
    ["Execution", "Disabled — preview consent only"],
    [
      "Sponsorship",
      "No gas is sponsored by this preview. Supported settlement would use a trusted prefunded relayer.",
    ],
    ["Risk", intent.support.reason],
    ["Expires", new Date(intent.expires).toISOString()],
  ];
  return (
    <>
      {rows.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd className="break">{value}</dd>
        </div>
      ))}
      {intent.disclosures.map((text) => (
        <div key={text}>
          <dt>Disclosure</dt>
          <dd>{text}</dd>
        </div>
      ))}
    </>
  );
}
