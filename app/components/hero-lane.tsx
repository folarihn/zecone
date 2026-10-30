// Hero visual: the recorded mainnet pilot payment drawn as a vertical lane.
// ZEC enters the shielded pool (where amount and addresses are encrypted), the
// relayer pays out, and ETH appears publicly on Base. Values are the real pilot
// transactions from app/evidence.ts; the single moving dot is CSS-only and stops
// under prefers-reduced-motion.
import { EVIDENCE, baseTx, zcashTx } from "../evidence";
import { BaseMark, ZcashMark } from "../ui";

export default function HeroLane() {
  return (
    <figure aria-label="How a ZecOne payment travels from Zcash to Base" className="relative mx-auto w-full max-w-[460px]">
      <div className="grid grid-cols-[44px_1fr] gap-x-4">
        {/* Lane */}
        <div className="relative row-span-4" aria-hidden="true">
          <div className="absolute inset-y-6 left-1/2 w-[2px] -translate-x-1/2 bg-gradient-to-b from-gold via-ivory/15 to-blue" />
          <div className="absolute left-1/2 top-[30%] h-[32%] w-[14px] -translate-x-1/2 rounded-full border border-lime/40 bg-forest-2" />
          <div className="absolute inset-y-6 left-0 right-0">
            <span className="zc-lane-dot block h-3 w-3 rounded-full bg-lime shadow-[0_0_0_4px_rgba(215,242,118,0.18)]" />
          </div>
        </div>

        {/* 1. Customer */}
        <Station
          icon={<ZcashMark size={26} />}
          label="Customer pays from a Zcash wallet"
          value={`${EVIDENCE.zcashDeposit.zec} ZEC`}
          detail={
            <a href={zcashTx(EVIDENCE.zcashDeposit.txid)} target="_blank" rel="noreferrer" className="underline-offset-2 hover:text-ink hover:underline">
              Zcash block {EVIDENCE.zcashDeposit.block.toLocaleString("en-US")} ↗
            </a>
          }
        />

        {/* 2. Shielded pool */}
        <div className="zc-hatch my-3 rounded-[18px] border border-lime/25 bg-forest-2 px-4 py-4">
          <p className="font-display text-[16px] font-semibold text-lime">Inside the shielded pool</p>
          <dl className="mt-2.5 grid gap-1.5 text-[14px]">
            {["Sender", "Recipient", "Amount"].map((k, i) => (
              <div key={k} className="flex items-center justify-between gap-3">
                <dt className="text-ivory/60">{k}</dt>
                <dd className="flex items-center gap-1">
                  <span className="zc-redact text-ivory" style={{ width: [86, 64, 48][i] }} />
                  <span className="sr-only">encrypted</span>
                </dd>
              </div>
            ))}
          </dl>
        </div>

        {/* 3. Relayer */}
        <div className="my-1 flex items-center gap-3 rounded-[14px] border border-ivory/10 px-4 py-3 text-[14.5px] text-ivory/80">
          <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-ivory text-[13px] font-bold text-forest">Z1</span>
          ZecOne relayer pays from its prefunded Base balance
        </div>

        {/* 4. Merchant */}
        <Station
          icon={<BaseMark size={26} />}
          label="Merchant receives ETH on Base, publicly"
          value={`${EVIDENCE.basePayout.eth.slice(0, 10)} ETH`}
          detail={
            <a href={baseTx(EVIDENCE.basePayout.txHash)} target="_blank" rel="noreferrer" className="underline-offset-2 hover:text-ink hover:underline">
              Base block {EVIDENCE.basePayout.block.toLocaleString("en-US")} ↗
            </a>
          }
          last
        />
      </div>
      <figcaption className="mt-5 pl-[60px] text-[13.5px] leading-relaxed text-ivory/55">
        Recorded ZecOne pilot on Zcash and Base mainnet. Not a live feed.
      </figcaption>
    </figure>
  );
}

function Station({ icon, label, value, detail, last = false }: { icon: React.ReactNode; label: string; value: string; detail: React.ReactNode; last?: boolean }) {
  return (
    <div className={`rounded-[18px] bg-ivory px-4 py-4 text-forest shadow-float ${last ? "mt-3" : ""}`}>
      <div className="flex items-start justify-between gap-3">
        <p className="text-[14px] font-medium text-muted">{label}</p>
        {icon}
      </div>
      <p className="mt-1 font-display text-[28px] font-semibold leading-tight tracking-[-0.02em] tabular-nums">{value}</p>
      <p className="mt-1 font-mono text-[13px] text-muted">{detail}</p>
    </div>
  );
}
