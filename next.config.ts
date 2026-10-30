import type { NextConfig } from "next";

// The ZecOne payment API (services/payments) runs as a separate process. Its
// public read-only endpoints are proxied same-origin by app/zecone/api/v1/[...path]
// (resolved at request time from ZECONE_BASE_URL); authenticated merchant calls go
// through server-side route handlers in app/api/*.
const config: NextConfig = {
  poweredByHeader: false,
  typescript: { tsconfigPath: "tsconfig.web.json" },
  devIndicators: false,
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
