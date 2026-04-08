import { defineConfig } from "electron-vite"
import { copyFileSync, existsSync } from "node:fs"
import path from "node:path"

import { claxedoAppDir, createElectronRenderer } from "../claxedo-app/vite.electron"

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
          name: "copy-claxedo-server",
          closeBundle() {
            const src = path.join(claxedoAppDir, "../claxedo-desktop/resources/claxedo-server.js")
            const dest = path.join(claxedoAppDir, "../claxedo-desktop/out/main/claxedo-server.js")
            if (existsSync(src)) {
              copyFileSync(src, dest)
              console.log("[vite] Copied claxedo-server.js to out/main/")
            }
          },
        },
      ],
      build: {
        rollupOptions: {
          input: { index: "src/main/index.ts" },
        },
      },
    },
    preload: {
      build: {
        rollupOptions: {
          input: { index: "src/preload/index.ts" },
        },
      },
    },
    renderer: createElectronRenderer(mode),
  }
})
