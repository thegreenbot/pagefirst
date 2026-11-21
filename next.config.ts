import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The published host serves the built app. No image optimizer is required.
  images: { unoptimized: true },
};

export default nextConfig;
