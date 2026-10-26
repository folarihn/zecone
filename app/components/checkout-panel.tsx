"use client";
// The ZecOne website uses the same embeddable component it ships in
// @zecone/sdk/react. Public checkout reads go through the same-origin /zecone
// rewrite (see next.config.ts), so the browser never talks to the API host.
import { ZecOneCheckout, type ZecOneCheckoutProps } from "../../sdk/src/react";

export default function CheckoutPanel(props: Omit<ZecOneCheckoutProps, "apiBaseUrl"> & { apiBaseUrl?: string }) {
  return <ZecOneCheckout apiBaseUrl={props.apiBaseUrl ?? "/zecone"} {...props} />;
}
