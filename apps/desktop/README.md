# WatchMyGate Desktop (Electron)

A native Windows/macOS/Linux window around the **same Next.js admin build the browser
uses**. There is no second UI codebase — this packages `apps/web-admin/out`.

## Why Electron rather than Tauri

The repo previously carried a Tauri shell. It was one config file and a README: no Rust
source, no `Cargo.toml`, never built. Replacing it cost nothing, so this was a free
decision rather than a migration.

Tauri produces a ~10 MB installer against Electron's ~150 MB, which is a genuine
advantage and not the deciding one. Tauri renders through the operating system's own
webview — WebView2 on Windows, WKWebView on macOS, WebKitGTK on Linux — so shipping it
means validating this console against **three** browser engines. Electron ships one
Chromium, the same engine the Playwright checks drive, so what is verified is what a
society gets.

Three CSS bugs surfaced in a single afternoon on this console. On a product whose value
is the interface, one predictable engine is worth the extra megabytes.

The cost is honest: ~150 MB installed and a few hundred MB of RAM. For an accountant's
desktop that is acceptable; it would not be on a guard's handset, which is why the gate
runs Flutter instead.

## Requirements

Node 22. That is the whole list — no Rust, no MSVC build tools, no WebKitGTK.

## Commands

```bash
cd apps/desktop && npm install   # once; downloads the Electron binary

npm run desktop:dev              # from the repo root — dev server inside the shell
npm run desktop:build            # installers into apps/desktop/dist
npm run smoke --prefix apps/desktop   # loads the console, prints what it got, exits
```

`smoke` is the one that belongs in CI. "It compiles" says nothing about whether the
protocol handler resolves a single file, and a shell that opens to a blank white window
should be caught here rather than by a society.

## If it dies with `Cannot read properties of undefined (reading 'isPackaged')`

`ELECTRON_RUN_AS_NODE=1` is set in your environment — VS Code's extension host sets it,
and every terminal opened inside the editor inherits it. With it set, the Electron binary
runs as plain Node, so `require("electron")` returns the *path to the executable* rather
than the API.

`launch.cjs` deletes the variable before spawning, so the npm scripts are immune. Running
the binary by hand from a VS Code terminal is not:

```bash
env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe .
```

`cross-env ELECTRON_RUN_AS_NODE=` does **not** work — an empty value is still a set
variable to the code that reads it.

`apps/desktop` is deliberately **outside** the root workspaces. Electron is a ~100 MB
download and CI never builds installers, so making every `npm ci` pay for it would slow
the pipeline down for nothing.

## How it loads the console

Not from `file://`. Two things break if it does, and both are fatal:

1. A `file://` page has the opaque origin `null`, so every API call arrives as
   `Origin: null` — which the API's allowlist rejects, correctly. Accepting it would let
   any local HTML file call the API with a committee member's session.
2. The static export references assets absolutely (`/_next/static/…`), which under
   `file://` resolve against the filesystem root and 404.

So `main.mjs` registers a privileged standard scheme and serves `out/` over it. The window
runs as the real origin **`app://wmg`**, which is the entry the API's `CORS_ORIGINS`
allowlist names.

`trailingSlash: true` in the Next config means routes are directories, so the handler
resolves a path with no file extension to the `index.html` inside it, and falls back to
the root shell for anything unmatched.

## Pointing it at an API

Resolved at runtime, never baked into the build — the same installer goes to every
society and they do not all use the same API.

1. `WMG_API_URL` in the environment
2. `config.json` beside the installed executable: `{ "apiUrl": "https://…" }`
3. `http://localhost:8080`

The value reaches the page as `window.__WMG_API__`, which is what
`apps/web-admin/src/lib/api.ts` already reads. The desktop build is therefore not a
special case anywhere in the console's own code.

## Security posture

`nodeIntegration: false`, `contextIsolation: true`, `sandbox: true`, `webSecurity: true`.

The preload exposes exactly one value — the API URL — and nothing else. Everything the
console does already happens in the page against the HTTP API, so there is nothing more
the shell needs to hand it. A preload that exposes `ipcRenderer` wholesale turns one XSS
in a dependency into a compromise of the user's machine.

External links open in the real browser rather than navigating this window, which has no
address bar and no way back.

## Before this is handed to a society

**The Windows installer must be code-signed.** An unsigned NSIS installer triggers a
SmartScreen warning that will stop a non-technical committee member dead, and telling
people to click through security warnings is a habit worth not teaching. Budget for an
OV certificate (~₹15–30k/year); EV clears SmartScreen immediately, OV builds reputation
over time.

macOS needs an Apple Developer ID and notarisation for the same reason.

Neither is wired up yet, and no installer should be distributed until they are.
