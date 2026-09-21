import { afterEach, expect, test } from "bun:test"
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import { existsSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { readFileSync } from "node:fs"

const desktopDir = path.resolve(import.meta.dirname, "..")
const built = path.join(desktopDir, "../agent-sdk-runtime/dist/launch/launch-gate-child.mjs")

const scratch: string[] = []
afterEach(async () => {
  for (const directory of scratch.splice(0)) await rm(directory, { recursive: true, force: true })
})

async function layout() {
  const root = await mkdtemp(path.join(tmpdir(), "launch-gate-packaging-"))
  scratch.push(root)
  return root
}

test("the gate child is built, so the main bundle has something to copy", () => {
  // The copy plugin throws when this is missing rather than shipping an app
  // whose every managed launch refuses at runtime.
  expect(existsSync(built)).toBe(true)
})

test("the main bundle copies the gate child beside itself and unpacks it from the asar", () => {
  const viteConfig = readFileSync(path.join(desktopDir, "electron.vite.config.ts"), "utf8")
  const builderConfig = readFileSync(path.join(desktopDir, "electron-builder.config.ts"), "utf8")

  expect(viteConfig).toContain("copy-launch-gate-child")
  expect(viteConfig).toContain("out/main/launch-gate-child.mjs")
  // Bundled, not external: nothing else puts this file on disk.
  expect(viteConfig).toContain('external: ["better-sqlite3", "@lydell/node-pty", "@vscode/windows-process-tree"]')
  expect(builderConfig).toContain('"**/out/main/launch-gate-child.mjs"')
})

test("the resolver finds the gate child in the built out/ layout", async () => {
  const root = await layout()
  const out = path.join(root, "out/main")
  await mkdir(out, { recursive: true })
  await writeFile(path.join(out, "launch-gate-child.mjs"), "// built entry\n")

  process.env.CLAXEDO_LAUNCH_GATE_CHILD = path.join(out, "launch-gate-child.mjs")
  try {
    const { resolveLaunchGateChild } = await import("@claxedo/agent-sdk-runtime/launch")
    expect(resolveLaunchGateChild().file).toBe(path.join(out, "launch-gate-child.mjs"))
  } finally {
    delete process.env.CLAXEDO_LAUNCH_GATE_CHILD
  }
})

test("an asar path resolves to its unpacked twin, because spawn cannot read an archive", async () => {
  const root = await layout()
  const packed = path.join(root, "Resources/app.asar/out/main")
  const unpacked = path.join(root, "Resources/app.asar.unpacked/out/main")
  await mkdir(unpacked, { recursive: true })
  await writeFile(path.join(unpacked, "launch-gate-child.mjs"), "// unpacked entry\n")

  process.env.CLAXEDO_LAUNCH_GATE_CHILD = path.join(packed, "launch-gate-child.mjs")
  try {
    const { resolveLaunchGateChild } = await import("@claxedo/agent-sdk-runtime/launch")
    expect(resolveLaunchGateChild().file).toBe(path.join(unpacked, "launch-gate-child.mjs"))
  } finally {
    delete process.env.CLAXEDO_LAUNCH_GATE_CHILD
  }
})

test("a gate child that is not on disk refuses the launch rather than crashing it", async () => {
  const root = await layout()
  process.env.CLAXEDO_LAUNCH_GATE_CHILD = path.join(root, "absent.mjs")
  try {
    const { resolveLaunchGateChild, LaunchRefusedError } = await import("@claxedo/agent-sdk-runtime/launch")
    expect(() => resolveLaunchGateChild()).toThrow(LaunchRefusedError)
  } finally {
    delete process.env.CLAXEDO_LAUNCH_GATE_CHILD
  }
})
