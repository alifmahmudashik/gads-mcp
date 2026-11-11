/** @type {import('next').NextConfig} */
const nextConfig = {
  // Claude connector URL is https://<domain>/mcp
  async rewrites() {
    return [{ source: "/mcp", destination: "/api/mcp" }];
  }
};
export default nextConfig;
