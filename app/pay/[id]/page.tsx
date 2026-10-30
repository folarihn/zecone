import type { Metadata } from "next";
import Link from "next/link";
import { ShieldCheck } from "lucide-react";
import CheckoutPanel from "../../components/checkout-panel";
import { Callout, Container } from "../../ui";

export const metadata: Metadata = { title: "Pay with shielded ZEC | ZecOne" };
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
    <main className="bg-canvas">
      <Container className="py-10 sm:py-14">
        <div className="mx-auto max-w-xl">
          <h1 className="zc-h2 text-ink">Complete your payment</h1>
          <p className="mt-3 text-[16px] leading-relaxed text-muted">
            This page updates by itself. Keep it open or come back to the same link. A payment address appears only on real
            checkouts; simulated demo checkouts are clearly marked and have nothing to pay.
          </p>
          <div className="mt-7">
            {valid ? (
              <CheckoutPanel paymentId={id} checkoutToken={t!} />
            ) : (
              <Callout tone="danger" title="This checkout link is incomplete">
                Ask the merchant to send the full link again. Do not send ZEC to an address from an incomplete link.
              </Callout>
            )}
          </div>
          <p className="mt-6 flex gap-2.5 text-[14px] leading-relaxed text-muted">
            <ShieldCheck size={18} aria-hidden="true" className="mt-0.5 shrink-0 text-forest" />
            <span>
              Your Zcash payment is shielded. The merchant&apos;s ETH payout on Base is public, and ZecOne (the relayer operator) can
              link the two.{" "}
              <Link href="/security" className="font-semibold text-ink underline underline-offset-4">
                How privacy works
              </Link>
            </span>
          </p>
        </div>
      </Container>
    </main>
  );
}
