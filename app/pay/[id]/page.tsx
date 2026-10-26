import type { Metadata } from "next";
import Link from "next/link";
import CheckoutPanel from "../../components/checkout-panel";
import { Container } from "../../ui";

export const metadata: Metadata = { title: "Pay with shielded ZEC — ZecOne" };
export const dynamic = "force-dynamic";

export default async function HostedCheckout({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ t?: string }>;
}) {
  const { id } = await params;
  const { t } = await searchParams;
  const valid = /^pay_[0-9a-f]{26}$/.test(id) && /^[0-9a-f]{40}$/.test(t ?? "");
  return (
    <main>
      <Container className="py-10 sm:py-14">
        <div className="mx-auto max-w-xl">
          <h1 className="text-[26px] font-semibold tracking-tight text-ink">Complete your payment</h1>
          <p className="mt-2 text-[14.5px] leading-relaxed text-muted">
            This page updates by itself — keep it open or come back to the same link. A payment address appears only on
            live checkouts; simulated demo checkouts are clearly marked and have nothing to pay.
          </p>
          <div className="mt-6">
            {valid ? (
              <CheckoutPanel paymentId={id} checkoutToken={t!} />
            ) : (
              <div className="rounded-2xl border border-line bg-surface p-6 text-[14px] text-muted">
                This checkout link is incomplete. Ask the merchant to send the full link again.
              </div>
            )}
          </div>
          <p className="mt-6 text-[12.5px] leading-relaxed text-muted">
            Your Zcash payment is shielded. The merchant&apos;s ETH payout on Base is public, and ZecOne (the relayer
            operator) can link the two. <Link href="/security" className="underline underline-offset-2">How privacy works</Link>
          </p>
        </div>
      </Container>
    </main>
  );
}
