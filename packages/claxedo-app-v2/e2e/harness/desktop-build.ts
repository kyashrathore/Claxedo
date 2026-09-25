import fs from "node:fs"
import path from "node:path"
import { ensureWorkspacePackagesBuilt, newestMtime, run, sourceMtime, type AppChoice } from "./app"

export const DESKTOP_DIR = path.resolve(import.meta.dirname, "../../../claxedo-desktop")
export const DESKTOP_MAIN = path.join(DESKTOP_DIR, "out/main/index.js")
const STAMP = path.join(DESKTOP_DIR, "out/claxedo-e2e-desktop.json")
const DESKTOP_SOURCES = ["src", "scripts", "resources", "electron.vite.config.ts", "vite.renderer.ts", "vite.renderer-v2.ts", "package.json"]

export type DesktopBuild = { built: boolean; ms: number }

function desktopSourceMtime(app: AppChoice) {
  return Math.max(sourceMtime(app), ...DESKTOP_SOURCES.map((entry) => newestMtime(path.join(DESKTOP_DIR, entry))))
}

function buildIsCurrent(app: AppChoice, mtime: number) {
  if (!fs.existsSync(STAMP) || !fs.existsSync(DESKTOP_MAIN)) return false
  const recorded = JSON.parse(fs.readFileSync(STAMP, "utf8")) as { app?: string; sourceMtime?: number }
  return recorded.app === app && typeof recorded.sourceMtime === "number" && recorded.sourceMtime >= mtime
}

async function step(label: string, script: string, env: NodeJS.ProcessEnv) {
  const result = await run(label, "bun", ["run", script], { cwd: DESKTOP_DIR, env })
  if (result.code !== 0) throw new Error(`${label} exited with ${result.code}:\n${result.tail()}`)
}

export async function ensureDesktopBuilt(app: AppChoice): Promise<DesktopBuild> {
  const started = Date.now()
  const mtime = desktopSourceMtime(app)
  if (buildIsCurrent(app, mtime)) return { built: false, ms: Date.now() - started }
  if (app === "v1") await ensureWorkspacePackagesBuilt()
  const env = { ...process.env, CLAXEDO_DESKTOP_RENDERER: app === "v2" ? "v2" : undefined, VITE_CLAXEDO_AUTH_ADAPTER: "desktop" }
  await step("desktop prebuild", "prebuild", env)
  await step(`desktop ${app} build`, "build:inner", env)
  fs.writeFileSync(STAMP, JSON.stringify({ app, sourceMtime: desktopSourceMtime(app), builtAt: Date.now() }))
  return { built: true, ms: Date.now() - started }
}
