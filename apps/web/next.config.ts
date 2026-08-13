import type { NextConfig } from "next";

const apiOrigin = process.env.CRM_AGENT_API_ORIGIN?.trim() || "http://127.0.0.1:3001";

const nextConfig: NextConfig = {
  // The local demo is intentionally opened through 127.0.0.1. Next 16 blocks
  // development assets and HMR upgrades from origins outside this allowlist.
  allowedDevOrigins: ["127.0.0.1"],
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: `${apiOrigin}/api/:path*`,
      },
    ];
  },
};

export default nextConfig;
