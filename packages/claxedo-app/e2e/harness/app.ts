import { spawn } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { captureOutput, exited } from "./process"

const APP_ROOT = path.resolve(import.meta.dirname, "../..")
const BUILD_STAMP = "claxedo-e2e-build.json"
const DIST_DIR = "dist-e2e"
const SOURCE_ENTRIES = ["src", "public", "index.html", "vite.cloud.config.ts", "vite.account-binding.ts", "vite.content-security-policy.ts", "content-security-policy.ts", "browser-preview.html", "cli-callback.html", "package.json", "../../plugins"]
const SKIPPED_DIRS = new Set(["node_modules"])

export function appDistDir() {
  return path.join(APP_ROOT, DIST_DIR)
}

export function signedDistDir() {
  return path.join(APP_ROOT, `${DIST_DIR}-signed`)
}

export function newestMtime(entry: string): number {
  if (!fs.existsSync(entry)) return 0
  const stat = fs.statSync(entry)
  if (!stat.isDirectory()) return stat.mtimeMs
  let newest = stat.mtimeMs
  for (const child of fs.readdirSync(entry, { withFileTypes: true })) {
    if (child.isDirectory() && SKIPPED_DIRS.has(child.name)) continue
    newest = Math.max(newest, newestMtime(path.join(entry, child.name)))
  }
  return newest
}

export function sourceMtime() {
  return Math.max(...SOURCE_ENTRIES.map((entry) => newestMtime(path.join(APP_ROOT, entry))))
}

function buildIsCurrent(distDir: string, mtime: number, serverUrl: string) {
  const stamp = path.join(distDir, BUILD_STAMP)
  if (!fs.existsSync(stamp) || !fs.existsSync(path.join(distDir, "index.html"))) return false
  const recorded = JSON.parse(fs.readFileSync(stamp, "utf8")) as { sourceMtime?: number; serverUrl?: string }
  return typeof recorded.sourceMtime === "number" && recorded.sourceMtime >= mtime && recorded.serverUrl === serverUrl
}

export async function run(label: string, command: string, args: string[], options: { cwd: string; env?: NodeJS.ProcessEnv }) {
  const child = spawn(command, args, { cwd: options.cwd, env: options.env ?? process.env, stdio: ["ignore", "pipe", "pipe"] })
  const owned = captureOutput(child)
  const code = await exited(child)
  return { code, tail: () => owned.log().split("\n").slice(-60).join("\n") }
}

export type AppBuild = { distDir: string; built: boolean; ms: number }

export async function ensureAppBuilt(input: { serverUrl: string; outDir?: string }): Promise<AppBuild> {
  const started = Date.now()
  const distDir = input.outDir ?? appDistDir()
  const mtime = sourceMtime()
  if (buildIsCurrent(distDir, mtime, input.serverUrl)) return { distDir, built: false, ms: Date.now() - started }
  const build = await run("app build", "node", ["./node_modules/vite/bin/vite.js", "build", "--config", "vite.cloud.config.ts", "--outDir", distDir, "--emptyOutDir"], {
    cwd: APP_ROOT,
    env: {
      ...process.env,
      VITE_CLAXEDO_SERVER_URL: input.serverUrl,
      VITE_CLAXEDO_AUTH_ADAPTER: "better-auth",
      NODE_OPTIONS: "--max-old-space-size=4096",
    },
  })
  if (build.code !== 0) throw new Error(`app build exited with ${build.code}:\n${build.tail()}`)
  const ms = Date.now() - started
  const stamp = { sourceMtime: mtime, serverUrl: input.serverUrl, builtAt: Date.now(), ms }
  fs.writeFileSync(path.join(distDir, BUILD_STAMP), JSON.stringify(stamp))
  return { distDir, built: true, ms }
}
