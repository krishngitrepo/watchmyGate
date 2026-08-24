/**
 * Launcher.
 *
 * Exists for one reason: **`ELECTRON_RUN_AS_NODE`**.
 *
 * VS Code's extension host sets that variable, and it is inherited by every terminal
 * opened inside the editor. With it set, the Electron binary runs as plain Node — so
 * `require("electron")` returns the *path to the executable* instead of the API, and the
 * app dies at startup with `Cannot read properties of undefined (reading 'isPackaged')`.
 *
 * That error names nothing useful and sends you hunting through application code that
 * was never wrong. Cost an hour once; it should cost nobody a second time.
 *
 * `cross-env ELECTRON_RUN_AS_NODE=` does not fix it — an empty value is still a set
 * variable to the C++ side that reads it. The variable has to be deleted, which is what
 * this does.
 */

const { spawn } = require("node:child_process");

// When run under Node, the `electron` package exports the path to its binary.
const electron = require("electron");

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

for (const argument of process.argv.slice(2)) {
  if (argument === "--dev") env.WMG_DEV = "1";
  if (argument === "--smoke") env.WMG_SMOKE = "1";
}

const child = spawn(electron, [__dirname], { stdio: "inherit", env, shell: false });
child.on("exit", (code) => process.exit(code ?? 0));
