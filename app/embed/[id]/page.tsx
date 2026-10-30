import type { Metadata } from "next";
import EmbedClient from "./embed-client";

export const metadata: Metadata = { title: "ZecOne Checkout" };
export const dynamic = "force-dynamic";

// Frame-able, chrome-less checkout for <iframe> integrations. Posts status
// messages to the parent window; the parent must still verify settlement on its
// own server (webhook or API) before granting anything.
export default async function Embed({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ t?: string; theme?: string }>;
}) {
  const { id } = await params;
  const { t, theme } = await searchParams;
  const valid = /^pay_[0-9a-f]{26}$/.test(id) && /^[0-9a-f]{40}$/.test(t ?? "");
  return (
    <main className="p-2" style={{ background: theme === "dark" ? "#102820" : "transparent" }}>
      {valid ? (
        <EmbedClient id={id} token={t!} theme={theme === "dark" ? "dark" : "light"} />
      ) : (
        <p className="p-4 text-[14px] text-muted">Invalid checkout link.</p>
      )}
    </main>
  );
}
