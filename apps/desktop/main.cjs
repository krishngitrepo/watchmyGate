/**
 * WatchMyGate desktop shell.
 *
 * A native window around the **same Next.js static export the browser uses**. There is no
 * second UI codebase — this packages `apps/web-admin/out`.
 *
 * ## Why Electron rather than Tauri
 *
 * Tauri produces a ~10 MB installer against Electron's ~150 MB, which is a real
 * advantage and not the deciding one. Tauri renders through the operating system's own
 * webview — WebView2 on Windows, WKWebView on macOS, WebKitGTK on Linux — so shipping it
 * means testing this console against *three* browser engines. Electron ships one
 * Chromium, the same engine the tests drive, so what is verified is what a society gets.
 *
 * On a product whose entire value is the interface, one predictable engine is worth the
 * extra megabytes.
 *
 * ## Why CommonJS in an ESM repo
 *
 * Not preference. Electron's main entry is CommonJS and assigns its exports dynamically,
 * so an ESM `main.mjs` fails twice over: named imports are invisible to Node's
 * CJS-to-ESM detection ("does not provide an export named 'BrowserWindow'"), and a
 * default import hands back something whose `app` is undefined. Both were hit and
 * measured rather than guessed. CommonJS is the supported path here.
 *
 * ## Why a custom `app://` protocol rather than `file://`
 *
 * Two reasons, both of which break the app outright otherwise:
 *
 *  1. A `file://` page has the opaque origin `null`. Every API call would arrive with
 *     `Origin: null`, which the API's CORS allowlist rejects — correctly, since
 *     reflecting a null origin would let any local HTML file call it.
 *  2. The static export references assets absolutely (`/_next/static/…`). Under `file://`
 *     those resolve against the filesystem root and 404.
 *
 * A privileged standard scheme gives the window the real origin `app://wmg`, which CORS
 * can name, and absolute paths resolve against the bundle as they would on a web server.
 */

const { app, BrowserWindow, net, protocol, shell } = require("electron");
const { existsSync, readFileSync } = require("node:fs");
const { dirname, join, normalize, resolve, sep } = require("node:path");
const { pathToFileURL } = require("node:url");

const HERE = __dirname;
const DEV = process.env.WMG_DEV === "1";

/** The origin this window runs as. Must match an entry in the API's CORS allowlist. */
const APP_ORIGIN = "app://wmg";

/** The packaged console. In dev the Next.js server serves it instead. */
const WEB_ROOT = app.isPackaged
  ? join(process.resourcesPath, "console")
  : resolve(HERE, "../web-admin/out");

/**
 * Where the API lives, resolved at **runtime**, never baked into the build.
 *
 * The same installer is handed to every society, and they do not all point at the same
 * API — a pilot runs against staging while everyone else is on production. Baking the URL
 * in would mean a separate build per environment, which is precisely what the web
 * console's `apiBase()` avoids by reading `window.__WMG_API__`.
 *
 * Order: an explicit environment variable, then a `config.json` sitting beside the
 * installed application, then localhost so a fresh checkout runs with no configuration.
 */
function resolveApiUrl() {
  if (process.env.WMG_API_URL) return process.env.WMG_API_URL;

  const configPath = app.isPackaged
    ? join(dirname(app.getPath("exe")), "config.json")
    : join(HERE, "config.json");

  try {
    if (existsSync(configPath)) {
      const parsed = JSON.parse(readFileSync(configPath, "utf8"));
      if (typeof parsed.apiUrl === "string" && parsed.apiUrl) return parsed.apiUrl;
    }
  } catch {
    // A hand-edited config.json with a stray comma must not stop the app booting. The
    // fallback below still produces a working window that reports its own connection
    // error, which is far easier to diagnose than an executable that does nothing.
  }

  return "http://localhost:8080";
}

const API_URL = resolveApiUrl();

// Must run before `app.ready`. `standard` gives real URL parsing and a real origin;
// `secure` puts the scheme on the same footing as https, so the browser does not treat
// the page as insecure and block APIs the console relies on.
protocol.registerSchemesAsPrivileged([
  {
    scheme: "app",
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
]);

/**
 * Serve the exported console.
 *
 * `trailingSlash: true` in the Next config means routes are directories — `/dashboard/`
 * is `out/dashboard/index.html` — so a path that is not a file is resolved to the
 * `index.html` inside it.
 */
function registerAppProtocol() {
  protocol.handle("app", async (request) => {
    const { pathname } = new URL(request.url);
    const decoded = decodeURIComponent(pathname);

    // Path traversal guard. `app://wmg/../../etc/passwd` must not escape the bundle;
    // this process can read the user's whole filesystem, so the check is not academic.
    const candidate = resolve(join(WEB_ROOT, normalize(decoded)));
    if (candidate !== WEB_ROOT && !candidate.startsWith(WEB_ROOT + sep)) {
      return new Response("Not found", { status: 404 });
    }

    let target = candidate;
    if (decoded.endsWith("/") || !decoded.split("/").pop()?.includes(".")) {
      target = join(candidate, "index.html");
    }

    if (!existsSync(target)) {
      // Anything unmatched falls back to the shell, so a deep link still opens the app
      // rather than a blank window. The console routes it client-side from there.
      target = join(WEB_ROOT, "index.html");
    }

    return net.fetch(pathToFileURL(target).toString());
  });
}

function createWindow() {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    backgroundColor: "#faf5ee",
    title: "WatchMyGate",
    // Nothing is shown until the first paint. A white flash before a warm-paper console
    // looks like a fault on a slow machine.
    show: false,
    webPreferences: {
      preload: join(HERE, "preload.cjs"),
      /*
       * How the API URL reaches the page.
       *
       * A sandboxed preload does not get a usable `process.env`, so the value is passed
       * as a renderer argument — the documented channel for exactly this — and read back
       * from `process.argv` in the preload.
       */
      additionalArguments: [`--wmg-api=${API_URL}`],
      // The three settings that decide whether a compromised page can read the disk.
      // A renderer showing remote-influenced content has no business holding Node.
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
    },
  });

  window.once("ready-to-show", () => window.show());

  // Every external link opens in the real browser. A committee member who clicks a
  // support link should not end up navigating the application window to a web page with
  // no address bar and no way back.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) void shell.openExternal(url);
    return { action: "deny" };
  });

  window.webContents.on("will-navigate", (event, url) => {
    const allowed = DEV ? "http://localhost:3000" : APP_ORIGIN;
    if (!url.startsWith(allowed)) {
      event.preventDefault();
      if (url.startsWith("https://")) void shell.openExternal(url);
    }
  });

  /*
   * Smoke mode.
   *
   * `WMG_SMOKE=1` loads the console, reports whether it rendered, and exits. It exists
   * because "the app compiles" says nothing about whether the protocol handler resolves
   * a single file — and a desktop shell that opens to a blank white window is exactly
   * the failure that would otherwise be discovered by a society rather than by CI.
   */
  if (process.env.WMG_SMOKE === "1") {
    window.webContents.once("did-finish-load", async () => {
      const title = await window.webContents.executeJavaScript("document.title");
      const api = await window.webContents.executeJavaScript(
        "String(window.__WMG_API__)",
      );
      console.log(`smoke: loaded "${title}" origin=${window.webContents.getURL()} api=${api}`);
      app.exit(title ? 0 : 1);
    });
    window.webContents.once("did-fail-load", (_event, code, description, url) => {
      console.error(`smoke: failed ${code} ${description} ${url}`);
      app.exit(1);
    });
  }

  if (DEV) {
    void window.loadURL("http://localhost:3000/");
  } else {
    void window.loadURL(`${APP_ORIGIN}/`);
  }

  return window;
}

app.whenReady().then(() => {
  registerAppProtocol();
  createWindow();

  app.on("activate", () => {
    // macOS keeps the process alive with no windows; clicking the dock icon reopens one.
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
