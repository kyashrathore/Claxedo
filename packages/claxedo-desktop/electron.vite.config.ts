import { defineConfig } from "electron-vite"
import { builtinModules, createRequire } from "node:module"
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"

const configRequire = createRequire(import.meta.url)

import { createElectronRenderer, desktopDir } from "./vite.renderer"

const channel = (() => {
  const raw = process.env.CLAXEDO_CHANNEL
  if (raw === "dev" || raw === "beta" || raw === "prod") return raw
  return "dev"
})()

// Telemetry config has to be BAKED, not read from the environment at runtime.
// The main process runs on an end user's machine, where CLAXEDO_POSTHOG_KEY
// and friends simply do not exist — so a shipped build reading only
// `process.env` sends nothing no matter what CI was given. These defines are
// what let an official release report anything at all; `src/main/telemetry.ts`
// still prefers a real `process.env` value when one is present, so a
// self-builder can override, and an unset variable bakes as `undefined` and
// leaves the build silent (the two-opt-in gate is unchanged).
const telemetryDefines = Object.fromEntries(
  (["CLAXEDO_POSTHOG_KEY", "CLAXEDO_POSTHOG_HOST", "CLAXEDO_TELEMETRY_MODE"] as const).map((name) => [
    `import.meta.env.${name}`,
    JSON.stringify(process.env[name]?.trim() || undefined),
  ]),
)

// ── Config ──

export default defineConfig(({ mode }) => {
  return {
    main: {
      define: {
        ...telemetryDefines,
        "import.meta.env.CLAXEDO_CHANNEL": JSON.stringify(channel),
        // The reviewed CIM script, CRLF-normalized + UTF-16LE + base64 — the
        // shape PowerShell's -EncodedCommand takes. A define rather than a
        // module import so nothing ever has to PARSE the .ps1: bun runs
        // process-metrics-source.ts straight from source for the release
        // gates and choked reading the PowerShell as JavaScript.
        CLAXEDO_WINDOWS_CIM_ENCODED: JSON.stringify(
          Buffer.from(
            readFileSync(
              path.join(desktopDir, "src/main/diagnostics/windows-cim-worker.ps1"),
              "utf8",
            ).replace(/\r?\n/g, "\r\n"),
            "utf16le",
          ).toString("base64"),
        ),
      },
      plugins: [
        {
          name: "copy-claxedo-server",
          closeBundle() {
            if (mode === "development") return
            for (const name of ["claxedo-server", "claxedo-engine-worker"]) {
              const src = path.join(desktopDir, "resources", name)
              const dest = path.join(desktopDir, "out/main", name)
              if (!existsSync(src)) continue
              rmSync(dest, { recursive: true, force: true })
              rmSync(path.join(desktopDir, `out/main/${name}.js`), { force: true })
              cpSync(src, dest, { recursive: true })
              console.log(`[vite] Copied ${name} bundle to out/main/`)
            }
          },
        },
      ],
      build: {
        // Bundle every dependency into the main process. Only native modules
        // stay external — they ship as the app's sole node_modules content.
        externalizeDeps: false,
        rollupOptions: {
          external: ["better-sqlite3", "node-pty", "@lydell/node-pty", "@vscode/windows-process-tree"],
          input: {
            index: "src/main/index.ts",
            "process-metrics-worker": "src/main/diagnostics/process-metrics-worker-entry.ts",
            "session-memory-worker": "src/main/diagnostics/session-memory-worker-entry.ts",
          },
        },
      },
    },
    preload: {
      plugins: [
        {
          name: "inline-react-grab-into-browser-preload",
          // React-grab's published runtime is a single browser-global IIFE
          // (`dist/index.global.js`) that assigns a `ReactGrabAPI` to
          // `window.__REACT_GRAB__`. electron-vite externalizes every
          // package.json dep by default; we sidestep the externals fight
          // by letting the preload import `react-grab` as a side-effect
          // stub and prepending the real IIFE at closeBundle, so the
          // final `browser-preload.cjs` is self-contained.
          closeBundle() {
            const pkgEntry = configRequire.resolve("react-grab/dist/index.global.js", {
              paths: [desktopDir],
            })
            const iife = readFileSync(pkgEntry, "utf8")
            const outPath = path.join(
              desktopDir,
              "out/preload/browser-preload.cjs",
            )
            if (!existsSync(outPath)) {
              console.warn("[vite] browser-preload output missing; skipping react-grab inline")
              return
            }
            const compiled = readFileSync(outPath, "utf8")
            const banner = "/* react-grab IIFE prepended by inline-react-grab-into-browser-preload */\n"
            // Defer the IIFE until DOMContentLoaded (or run immediately if
            // already past it). Errors get stashed for diag IPC.
            const wrapped =
              "globalThis.__CLAXEDO_RUN_REACT_GRAB_IIFE__ = function() {\n" +
              "  if (globalThis.__REACT_GRAB_MODULE__ || globalThis.__CLAXEDO_REACT_GRAB_IIFE_RAN__) return;\n" +
              "  globalThis.__CLAXEDO_REACT_GRAB_IIFE_RAN__ = true;\n" +
              "  try {\n" +
              "    (function(){\n" +
              iife +
              "\n    }).call(globalThis);\n" +
              "  } catch (e) {\n" +
              "    globalThis.__CLAXEDO_REACT_GRAB_IIFE_ERROR__ = { message: String(e && e.message || e), stack: e && e.stack || null };\n" +
              "    console.error('[react-grab] init failed', e);\n" +
              "  }\n" +
              "};\n" +
              "if (typeof document !== 'undefined') {\n" +
              "  if (document.readyState === 'loading') {\n" +
              "    document.addEventListener('DOMContentLoaded', function(){ globalThis.__CLAXEDO_RUN_REACT_GRAB_IIFE__(); }, { once: true });\n" +
              "  } else {\n" +
              "    globalThis.__CLAXEDO_RUN_REACT_GRAB_IIFE__();\n" +
              "  }\n" +
              "}\n"
            writeFileSync(outPath, banner + wrapped + "\n" + compiled)
            console.log("[vite] Inlined react-grab IIFE into out/preload/browser-preload.cjs")
          },
        },
      ],
      build: {
        // Fully self-contained preload: inline every dependency; only
        // electron and node builtins stay external (see external fn below).
        externalizeDeps: false,
        rollupOptions: {
          external: (id) => {
            if (id === "electron") return true
            if (id.startsWith("electron/")) return true
            if (id.startsWith("node:")) return true
            if (builtinModules.includes(id)) return true
            return false
          },
          input: {
            index: "src/preload/index.ts",
            // Browser-tab guest preload, injected into the agent-browser
            // <webview>'s guest context (separate from the host preload
            // above). Must be CommonJS — will-attach-webview forces
            // `sandbox: true` on guests and Electron's sandboxed preload
            // runner refuses ESM.
            "browser-preload": "src/browser-preload/index.ts",
          },
          // electron-vite preload doesn't support multi-format outputs.
          // CJS is the only format that satisfies both entries (sandbox
          // guest + main window preload).
          output: {
            format: "cjs",
            entryFileNames: "[name].cjs",
            chunkFileNames: "[name]-[hash].cjs",
          },
        },
      },
    },
    renderer: createElectronRenderer(mode),
  }
})
