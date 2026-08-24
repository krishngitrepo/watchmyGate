/**
 * Preload — the only bridge between the shell and the page.
 *
 * CommonJS deliberately: with `sandbox: true` a preload script is not an ES module, so
 * this file cannot be `.mjs` however much the rest of the repo is.
 *
 * It exposes exactly one value. Everything the console does — every fetch, every token —
 * already happens in the page against the HTTP API, so there is nothing else the shell
 * needs to hand it. A preload that exposes `ipcRenderer` wholesale, or anything touching
 * the filesystem, converts one XSS in a dependency into a machine compromise; the whole
 * point of the sandbox is not to reopen that door out of convenience.
 */

const { contextBridge } = require("electron");

/**
 * The API base URL, passed from the main process as a renderer argument.
 *
 * `apps/web-admin/src/lib/api.ts` reads `window.__WMG_API__` and falls back to
 * localhost, which is the same mechanism the hosted deployment uses. The desktop build
 * is therefore not a special case in the console's code — it just supplies the value a
 * different way.
 */
const prefix = "--wmg-api=";
const argument = process.argv.find((value) => value.startsWith(prefix));

if (argument) {
  contextBridge.exposeInMainWorld("__WMG_API__", argument.slice(prefix.length));
}
