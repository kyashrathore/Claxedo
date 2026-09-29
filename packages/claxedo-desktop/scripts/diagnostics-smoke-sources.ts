import { existsSync } from "node:fs"
import { createRequire } from "node:module"

import type { ElectronDiagnosticsSource } from "../src/main/diagnostics/electron-source"

/**
 * The built worker must be loaded by the runtime that loads it in the product:
 * the Electron binary as Node. This smoke runs under bun, whose loader answers
 * a missing named import from a CJS module with `undefined` where Node's ESM
 * linker throws — a worker bundle that reached `electron` stayed green here
 * and died in the app.
 */
export function electronBinary(): string {
  const electron: unknown = createRequire(import.meta.url)("electron")
  if (typeof electron !== "string" || !existsSync(electron)) {
    throw new Error("Diagnostics smoke needs the electron package's binary to run the built worker")
  }
  return electron
}

export function emptyElectronSource(): ElectronDiagnosticsSource {
  return {
    id: "electron",
    domain: "host",
    accuracy: "native",
    capabilities: {
      cpu: true,
      rss: true,
      ancestry: true,
      creationIdentity: true,
      actionIdentity: false,
    },
    collect: () => [],
    registerRoot: () => () => undefined,
  }
}
