import fs from "node:fs"
import path from "node:path"
import { newestMtime, run, sourceMtime } from "./app"

export const DESKTOP_DIR = path.resolve(import.meta.dirname, "../../../claxedo-desktop")
export const DESKTOP_MAIN = path.join(DESKTOP_DIR, "out/main/index.js")
const STAMP = path.join(DESKTOP_DIR, "out/claxedo-e2e-desktop.json")
const DESKTOP_SOURCES = ["src", "scripts", "resources", "electron.vite.config.ts", "vite.renderer.ts", "vite.renderer-v2.ts", "package.json"]

export type DesktopBuild = { built: boolean; ms: number }

function desktopSourceMtime() {
  return Math.max(sourceMtime(), ...DESKTOP_SOURCES.map((entry) => newestMtime(path.join(DESKTOP_DIR, entry))))
}

function buildIsCurrent(mtime: number) {
  if (!fs.existsSync(STAMP) || !fs.existsSync(DESKTOP_MAIN)) return false
  const recorded = JSON.parse(fs.readFileSync(STAMP, "utf8")) as { sourceMtime?: number }
  return typeof recorded.sourceMtime === "number" && recorded.sourceMtime >= mtime
}

async function step(label: string, script: string, env: NodeJS.ProcessEnv) {
  const result = await run(label, "bun", ["run", script], { cwd: DESKTOP_DIR, env })
  if (result.code !== 0) throw new Error(`${label} exited with ${result.code}:\n${result.tail()}`)
}

export async function ensureDesktopBuilt(): Promise<DesktopBuild> {
  const started = Date.now()
  const mtime = desktopSourceMtime()
  if (buildIsCurrent(mtime)) return { built: false, ms: Date.now() - started }
  const env = {
    ...process.env,
    CLAXEDO_DESKTOP_RENDERER: "v2",
    VITE_CLAXEDO_HOSTED_ACTIVATION: "true",
    VITE_CLAXEDO_AUTH_ADAPTER: "desktop",
  }
  await step("desktop prebuild", "prebuild", env)
  await step("desktop build", "build:inner", env)
  fs.writeFileSync(STAMP, JSON.stringify({ sourceMtime: desktopSourceMtime(), builtAt: Date.now() }))
  return { built: true, ms: Date.now() - started }
}
