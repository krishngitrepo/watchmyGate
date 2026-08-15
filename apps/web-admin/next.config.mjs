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
 * ---
 *
 * **Do not run `npm run admin:build` while `npm run admin:dev` is up.**
 *
 * Both use `.next`, and the build replaces chunks the dev server has already handed to
 * open browser tabs. The tab then dies with `__webpack_modules__[moduleId] is not a
 * function`, an error that names webpack internals and nothing else — so the instinct is
 * to go hunting through application code that was never wrong. The fix is to restart the
 * dev server; nothing in `src/` is at fault.
 *
 * This is worth stating because the repo-root `npm run build` builds this app too, so an
 * ordinary full-repo build breaks a running dev session.
 *
 * Pointing the build at its own `distDir` looks like the fix and is not: with
 * `output: "export"` that setting relocates the *exported* files, so `out/` stops being
 * produced and the Tauri packaging step silently loses its input, while `.next` gets
 * overwritten exactly as before. Measured, not assumed.
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
