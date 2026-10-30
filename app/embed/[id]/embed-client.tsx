"use client";
import CheckoutPanel from "../../components/checkout-panel";

export default function EmbedClient({ id, token, theme }: { id: string; token: string; theme: "light" | "dark" }) {
  const post = (type: string, state: string) => {
    if (window.parent !== window) window.parent.postMessage({ source: "zecone-checkout", type, paymentId: id, state }, "*");
  };
  return (
    <CheckoutPanel
      paymentId={id}
      checkoutToken={token}
      theme={theme}
      compact
      onStatusChange={(c) => post("status", c.state)}
      onCompleted={(c) => post("completed", c.state)}
      onExpired={(c) => post("expired", c.state)}
      onFailed={(c) => post("failed", c.state)}
    />
  );
}
