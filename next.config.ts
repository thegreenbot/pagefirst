import type { NextConfig } from "next";
import { SECURITY_HEADERS } from "./lib/http/headers";

const nextConfig: NextConfig = {
  // The published host serves the built app. No image optimizer is required.
  images: { unoptimized: true },
  poweredByHeader: false,
  async headers() {
    return [{ source: "/:path*", headers: SECURITY_HEADERS }];
  },
};

export default nextConfig;
