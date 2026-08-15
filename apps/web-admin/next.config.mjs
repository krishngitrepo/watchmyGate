/**
 * Static export.
 *
 * `output: "export"` produces plain files in `out/`, which is what the Tauri desktop
 * shell packages — Tauri ships files, not a Node server. It also means the console
 * deploys to any static host for effectively nothing.
 *
 * The consequence to keep in mind: no server components fetching data, no API routes,
 * no middleware. Every page talks to the API from the browser. That is not a limitation
 * here — the API is a separate service and the money rules live server-side by design,
 * so there was never anything for a Next.js server to do.
 *
 * @type {import('next').NextConfig}
 */
const nextConfig = {
  output: "export",
  reactStrictMode: true,
  // Static export cannot run the image optimiser, which needs a server.
  images: { unoptimized: true },
  // Directory-style URLs so the export works on hosts without rewrite rules.
  trailingSlash: true,
};

export default nextConfig;
