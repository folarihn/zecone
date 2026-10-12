import type { NextConfig } from "next";
const config: NextConfig = {
  poweredByHeader: false,
  typescript: { tsconfigPath: "tsconfig.web.json" },
  devIndicators: false,
};
export default config;
