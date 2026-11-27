import type { NextConfig } from "next";
import { SECURITY_HEADERS } from "./lib/http/headers";

const nextConfig: NextConfig = {
  // The published host serves the built app. No image optimizer is required.
  images: { unoptimized: true },
  poweredByHeader: false,
  // Theme packages are read from disk at render time (lib/theme/package.ts).
  outputFileTracingIncludes: { "/**/*": ["./themes/**/*"] },
  async headers() {
    return [{ source: "/:path*", headers: SECURITY_HEADERS }];
  },
};

export default nextConfig;
