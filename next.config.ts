import type { NextConfig } from "next";

// The ZecOne payment API (services/payments) runs as a separate process. Only
// its PUBLIC, read-only endpoints are proxied same-origin so browsers never need
// to reach the API host directly. Authenticated merchant calls go through
// server-side route handlers in app/api/*, which hold credentials.
const PAYMENTS_API = (process.env.ZECONE_BASE_URL ?? "http://127.0.0.1:4321").replace(/\/+$/, "");

const config: NextConfig = {
  poweredByHeader: false,
  typescript: { tsconfigPath: "tsconfig.web.json" },
  devIndicators: false,
  async rewrites() {
    return [
      { source: "/zecone/api/v1/checkout/:id", destination: `${PAYMENTS_API}/api/v1/checkout/:id` },
      { source: "/zecone/api/v1/checkout/:id/events", destination: `${PAYMENTS_API}/api/v1/checkout/:id/events` },
      { source: "/zecone/api/v1/quote/preview", destination: `${PAYMENTS_API}/api/v1/quote/preview` },
      { source: "/zecone/api/v1/health", destination: `${PAYMENTS_API}/api/v1/health` },
    ];
  },
  async headers() {
    const base = [
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    ];
    return [
      {
        // Everything except the embeddable checkout refuses to be framed. No CSP is set
        // here so the local wallet gateway's nonce-based CSP is never overwritten.
        source: "/((?!embed/).*)",
        headers: [...base, { key: "X-Frame-Options", value: "DENY" }],
      },
      {
        // The embed view is token-scoped and read-only, so any merchant site may frame it.
        source: "/embed/:path*",
        headers: [...base, { key: "Content-Security-Policy", value: "frame-ancestors *" }],
      },
    ];
  },
};
export default config;
