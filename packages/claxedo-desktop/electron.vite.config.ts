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

// ── Config ──

export default defineConfig(({ mode }) => {
  return {
    main: {
      define: {
        "import.meta.env.CLAXEDO_CHANNEL": JSON.stringify(channel),
      },
      plugins: [
        {
          name: "encode-reviewed-windows-cim-worker",
          enforce: "pre",
          resolveId(source, importer) {
            if (!source.endsWith("?encoded") || !importer) return
            return `\0windows-cim-encoded:${path.resolve(path.dirname(importer), source.slice(0, -"?encoded".length))}`
          },
          load(id) {
            const prefix = "\0windows-cim-encoded:"
            if (!id.startsWith(prefix)) return
            const script = readFileSync(id.slice(prefix.length), "utf8").replace(/\r?\n/g, "\r\n")
            return `export default ${JSON.stringify(Buffer.from(script, "utf16le").toString("base64"))}`
          },
        },
        {
          name: "copy-claxedo-server",
          closeBundle() {
            if (mode === "development") return
            const src = path.join(desktopDir, "resources/claxedo-server")
            const dest = path.join(desktopDir, "out/main/claxedo-server")
            if (existsSync(src)) {
              rmSync(dest, { recursive: true, force: true })
              rmSync(path.join(desktopDir, "out/main/claxedo-server.js"), { force: true })
              cpSync(src, dest, { recursive: true })
              console.log("[vite] Copied split claxedo-server bundle to out/main/")
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
