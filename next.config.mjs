import { createRequire } from "node:module";

// Read from package.json at build time, so the version on screen is always the
// version that was built - there is no second place to remember to bump.
const { version } = createRequire(import.meta.url)("./package.json");

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: "export",
  trailingSlash: true,
  images: { unoptimized: true },
  env: { NEXT_PUBLIC_APP_VERSION: version },
};

export default nextConfig;
