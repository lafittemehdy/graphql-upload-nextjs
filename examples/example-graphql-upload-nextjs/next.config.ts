import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ['graphql-upload-nextjs'],
  turbopack: {
    root: __dirname,
  },
};

export default nextConfig;
