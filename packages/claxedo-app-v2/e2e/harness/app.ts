import { spawn } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { captureOutput, exited } from "./process"

export type AppChoice = "v1" | "v2"

const V2_ROOT = path.resolve(import.meta.dirname, "../..")
const REPO_ROOT = path.resolve(V2_ROOT, "../..")
const BUILD_STAMP = "claxedo-e2e-build.json"
const DIST_DIR = "dist-e2e"
const SOURCE_ENTRIES = ["src", "public", "index.html", "vite.cloud.config.ts", "vite.browser-auth.ts", "package.json"]
const SKIPPED_DIRS = new Set(["node_modules", "legacy"])

export function appChoice(): AppChoice {
  const value = process.env.CLAXEDO_E2E_APP ?? "v2"
  if (value === "v1" || value === "v2") return value
  throw new Error(`CLAXEDO_E2E_APP="${value}" is neither v1 nor v2`)
}

export function appPackageDir(app: AppChoice) {
  return app === "v1" ? path.join(REPO_ROOT, "packages/claxedo-app") : V2_ROOT
}

export function appDistDir(app: AppChoice) {
  return path.join(appPackageDir(app), DIST_DIR)
}

function newestMtime(entry: string): number {
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

function sourceMtime(app: AppChoice) {
  const pkg = appPackageDir(app)
  return Math.max(...SOURCE_ENTRIES.map((entry) => newestMtime(path.join(pkg, entry))))
}

function buildIsCurrent(app: AppChoice, mtime: number, serverUrl: string) {
  const stamp = path.join(appDistDir(app), BUILD_STAMP)
  if (!fs.existsSync(stamp) || !fs.existsSync(path.join(appDistDir(app), "index.html"))) return false
  const recorded = JSON.parse(fs.readFileSync(stamp, "utf8")) as { sourceMtime?: number; serverUrl?: string }
  return typeof recorded.sourceMtime === "number" && recorded.sourceMtime >= mtime && recorded.serverUrl === serverUrl
}

async function run(label: string, command: string, args: string[], options: { cwd: string; env?: NodeJS.ProcessEnv }) {
  const child = spawn(command, args, { cwd: options.cwd, env: options.env ?? process.env, stdio: ["ignore", "pipe", "pipe"] })
  const owned = captureOutput(child)
  const code = await exited(child)
  return { code, tail: () => owned.log().split("\n").slice(-60).join("\n") }
}

async function ensureWorkspacePackagesBuilt() {
  if (fs.existsSync(path.join(REPO_ROOT, "packages/claxedo-helpers/dist"))) return
  const result = await run("bun run build:packages", "bun", ["run", "build:packages", "--", "--continue"], { cwd: REPO_ROOT })
  if (result.code !== 0) console.warn(`[harness] build:packages exited with ${result.code}; the app build decides whether that matters\n${result.tail()}`)
}

export type AppBuild = { distDir: string; built: boolean; ms: number }

export async function ensureAppBuilt(app: AppChoice, input: { serverUrl: string }): Promise<AppBuild> {
  const started = Date.now()
  const distDir = appDistDir(app)
  const mtime = sourceMtime(app)
  if (buildIsCurrent(app, mtime, input.serverUrl)) return { distDir, built: false, ms: Date.now() - started }
  if (app === "v1") await ensureWorkspacePackagesBuilt()
  const build = await run(`${app} build`, "node", ["./node_modules/vite/bin/vite.js", "build", "--config", "vite.cloud.config.ts", "--outDir", DIST_DIR], {
    cwd: appPackageDir(app),
    env: {
      ...process.env,
      VITE_CLAXEDO_SERVER_URL: input.serverUrl,
      VITE_CLAXEDO_AUTH_ADAPTER: "better-auth",
      NODE_OPTIONS: "--max-old-space-size=4096",
    },
  })
  if (build.code !== 0) throw new Error(`${app} build exited with ${build.code}:\n${build.tail()}`)
  const ms = Date.now() - started
  const stamp = { app, sourceMtime: mtime, serverUrl: input.serverUrl, builtAt: Date.now(), ms }
  fs.writeFileSync(path.join(distDir, BUILD_STAMP), JSON.stringify(stamp))
  return { distDir, built: true, ms }
}
