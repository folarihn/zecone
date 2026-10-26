import Wallet from "../wallet";
export const dynamic = "force-dynamic";
export default function Page() {
  return (
    <div className="wallet-scope">
      <Wallet />
    </div>
  );
}
