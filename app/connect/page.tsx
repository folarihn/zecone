import Connection from "./popup";
export const dynamic = "force-dynamic";
export default function Page() {
  return (
    <div className="wallet-scope">
      <Connection />
    </div>
  );
}
