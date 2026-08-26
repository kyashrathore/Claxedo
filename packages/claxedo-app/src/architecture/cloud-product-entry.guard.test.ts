import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { shortestForbiddenImportChain, type ProductImportRef } from "./import-graph"

const appRoot = path.resolve(import.meta.dir, "../..")

/**
 * Cloud product entry boundary — the mirror image of the local guard.
 *
 * The hosted browser entry may reach hosted identity, WorkGraph, Documents, and
 * hosted API clients freely; those are its own capabilities. What it must never
 * reach is the DESKTOP half: Electron main/preload APIs, the desktop package,
 * and the local server implementation. A browser bundle that imports `electron`
 * does not merely bloat — it cannot execute, and the failure surfaces at run
 * time in a deployed Pages build rather than in CI.
 *
 * Unlike the local boundary, this one is already clean today, so it enforces
 * rather than characterizes from the start. Unit 10 moves the assertion to
 * `@claxedo/cloud-app` once the hosted entry physically lives there; until then
 * the entry under test is `app/entry/main.tsx` in this package.
 */

/** Packages that belong to the desktop/local half of the split. */
const DESKTOP_PACKAGES = [
  "electron",
  "@electron-toolkit/preload",
  "@claxedo/desktop",
  "@claxedo/local-server",
  "@claxedo/server",
  "better-sqlite3",
  "@lydell/node-pty",
]

/** In-package source roots that will own Electron-specific adapters. */
const DESKTOP_SOURCE_ROOTS = ["platform/desktop/electron", "platform/desktop/preload"]

export function isDesktopCapability(ref: ProductImportRef) {
  if (DESKTOP_PACKAGES.some((pkg) => ref.specifier === pkg || ref.specifier.startsWith(`${pkg}/`))) return true
  const module = ref.module
  if (!module) return false
  return DESKTOP_SOURCE_ROOTS.some(
    (root) => module === root || module.startsWith(`${root}/`) || module.startsWith(root),
  )
}

function fixtureApp(files: Record<string, string>) {
  const root = mkdtempSync(path.join(tmpdir(), "claxedo-cloud-boundary-"))
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "fixture", exports: {} }))
  for (const [rel, text] of Object.entries(files)) {
    const file = path.join(root, "src", rel)
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, text)
  }
  return root
}

describe("cloud product entry boundary", () => {
  test("reports the shortest chain to an injected Electron edge", () => {
    const root = fixtureApp({
      "entry.ts": `import "./shell"\nimport "./titlebar"\n`,
      "shell.ts": `import "./deep"\n`,
      "deep.ts": `import { ipcRenderer } from "electron"\nexport const ipc = ipcRenderer\n`,
      "titlebar.ts": `import { ipcRenderer } from "electron"\nexport const t = ipcRenderer\n`,
    })
    try {
      expect(
        shortestForbiddenImportChain({ appRoot: root, entry: "entry.ts", isForbidden: isDesktopCapability }),
      ).toEqual({
        chain: ["entry.ts", "titlebar.ts"],
        specifier: "electron",
        module: null,
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("reports an injected local-server implementation edge", () => {
    const root = fixtureApp({
      "entry.ts": `import "./data"\n`,
      "data.ts": `import { createApp } from "@claxedo/local-server"\nexport const a = createApp\n`,
    })
    try {
      expect(
        shortestForbiddenImportChain({ appRoot: root, entry: "entry.ts", isForbidden: isDesktopCapability }),
      ).toEqual({
        chain: ["entry.ts", "data.ts"],
        specifier: "@claxedo/local-server",
        module: null,
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("allows hosted capabilities, which are this entry's own closure", () => {
    const root = fixtureApp({
      "entry.ts": `import "./platform/auth/auth-client"\nimport "@clerk/clerk-js"\n`,
      "platform/auth/auth-client.ts": `export const clerk = true\n`,
    })
    try {
      expect(
        shortestForbiddenImportChain({ appRoot: root, entry: "entry.ts", isForbidden: isDesktopCapability }),
      ).toBeNull()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("the hosted browser entry reaches no desktop capability", () => {
    expect(
      shortestForbiddenImportChain({
        appRoot,
        entry: "app/entry/main.tsx",
        isForbidden: isDesktopCapability,
      }),
    ).toBeNull()
  })
})
