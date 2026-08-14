# WatchMyGate Desktop (Tauri)

A native Windows/macOS/Linux wrapper around the **same Next.js admin build** the browser
uses. There is no second UI codebase — Tauri packages the static export.

That is also why the money package matters: it runs inside this app exactly as it runs
on the server, so a bill previewed on the desktop and the bill filed for GST are
produced by the same code.

## Why Tauri rather than Electron

Electron ships a whole Chromium runtime with every app — roughly 150 MB and several
hundred MB of RAM before your code does anything. Tauri uses the operating system's own
webview, so the installer is closer to 10 MB. For an accountant's laptop that is the
difference between a tool they keep and one they uninstall.

## Requirements

- Rust toolchain (`rustup`)
- On Windows: WebView2 (present on Windows 11 by default)
- On Linux: `libwebkit2gtk-4.1-dev`, `libssl-dev`

## Commands

```bash
npm run desktop:dev     # runs the admin dev server inside the desktop shell
npm run desktop:build   # produces installers in src-tauri/target/release/bundle
```

## Notes

`frontendDist` points at `apps/web-admin/out`, which is why the admin app is configured
for **static export** (`output: 'export'`). Tauri packages files, not a Node server —
server-side rendering and Next.js API routes are unavailable by design. Nothing is lost,
because the API is a separate TypeScript service.

The CSP in `tauri.conf.json` restricts outbound connections to the API and Razorpay.
Widen it deliberately, never reflexively — a desktop app with an open CSP is a browser
with the address bar removed.
